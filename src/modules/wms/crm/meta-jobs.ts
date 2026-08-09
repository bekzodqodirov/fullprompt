import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { landInboundLead } from './inbound';
import { isPermanentGraphError, mapFieldData, metaConfig, type LeadgenEvent } from './meta-leads';
import { metaSourceKey } from './inbound-webhook';

export const JOB_META_LEAD = 'leads.meta';

/** The Graph version. Meta keeps each for two years; bumping it is a deploy. */
const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Read one advert lead and land it.
 *
 * Deliberately a job rather than part of the webhook: the request has to be
 * answered 200 within seconds or Meta sends the whole batch again, and this
 * makes a network call to a third party that has rate limits and bad days.
 *
 * The idempotency is NOT here — it is `lead_intakes`' unique index on
 * (channel, external_id). A retry after a half-finished run therefore cannot
 * create a second lead, which is exactly what a retrying queue needs.
 */
export async function registerMetaLeadWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_META_LEAD);
  await boss.work<LeadgenEvent>(JOB_META_LEAD, async (jobs) => {
    const config = metaConfig();
    if (!config) {
      // The secrets left the environment between the webhook and the job.
      // Nothing to do and nothing to retry towards.
      logger.warn('[meta-leads] no config; dropping queued leads');
      return;
    }
    for (const job of jobs) {
      const event = job.data;
      if (!event?.leadgenId) continue;

      const url = `${GRAPH}/${encodeURIComponent(event.leadgenId)}?fields=field_data,created_time,ad_id,form_id,platform&access_token=${encodeURIComponent(config.pageToken)}`;
      const response = await fetch(url);
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        if (isPermanentGraphError(response.status, payload)) {
          // Swallowed on purpose: throwing would retry a lead Meta will never
          // hand over — a deleted lead, or a page token that has been revoked
          // and needs a person, not another attempt.
          logger.error(
            { status: response.status, leadgenId: event.leadgenId, payload },
            '[meta-leads] refused; giving up on this lead',
          );
          continue;
        }
        // Rate limit or a five-hundred: our turn again in a moment.
        throw new Error(`[meta-leads] graph ${response.status}`);
      }

      const lead = (payload ?? null) as { field_data?: unknown; platform?: unknown } | null;
      const fields = mapFieldData(lead?.field_data ?? null);
      const result = await landInboundLead({
        channel: 'meta',
        // Instagram and Facebook lead forms arrive through the SAME webhook,
        // and the WEBHOOK payload does not say which surface the advert ran on
        // — but the lead object does, and the read above now asks for it.
        // They are different adverts with different money behind them, and
        // `funnelReport` is the one screen that answers which is worth paying
        // for. Absent or unrecognised stays «meta», which is still the honest
        // answer; guessing would put a lie into that same report.
        sourceKey: metaSourceKey(lead?.platform),
        externalId: event.leadgenId,
        ref: {
          platform: lead?.platform ?? null,
          form_id: event.formId,
          page_id: event.pageId,
          ad_id: event.adId,
          created_time: event.createdTime,
        },
        name: fields.name,
        phone: fields.phone,
        note: fields.note,
      });
      logger.info(
        { leadgenId: event.leadgenId, outcome: result.outcome, reason: result.reason },
        '[meta-leads] landed',
      );
    }
  });
}
