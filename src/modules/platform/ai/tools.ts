import { composeMyDayText } from '../tasks/digest';
import { ANALYST_ROW_CAP, runAnalystSql } from './sql-runner';
import type { ModelToolSpec } from './model';

/**
 * The assistant's hands, built PER ACTOR so a tool the person may not hold is
 * not in the map at all — a hallucinated call gets an error tool_result, not
 * an execution. Tier 1 wraps the exact functions the screens and the staff
 * bot already answer with, actor threaded through (round 36's rule: the bot
 * may know only what the person already knows). Tier 2 — the super_admin /
 * admin ROLE, round 21's shape, a stated reversible widening — adds raw SQL
 * under the 0080 fence and the two report functions that make money answers
 * true.
 *
 * The wms wrappers are reached by dynamic import: platform never imports wms
 * statically (the startBoss crossing).
 */

export interface AssistantActor {
  id: string;
  fullName: string;
  locale: string | null;
  roles: string[];
  permissions: Set<string>;
  warehouseScoped: boolean;
  warehouseIds: string[];
}

export function isAnalyst(actor: Pick<AssistantActor, 'roles'>): boolean {
  return actor.roles.includes('super_admin') || actor.roles.includes('admin');
}

export interface AssistantTool extends ModelToolSpec {
  run(input: Record<string, unknown>): Promise<string>;
}

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === 'string' ? (input[key] as string).trim() : '';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildTools(actor: AssistantActor): AssistantTool[] {
  const tools: AssistantTool[] = [
    {
      name: 'lookup_code',
      description:
        'Найти по коду: клиент (GS777), коробка (YW26-000123), ящик (CR-…) или партия/машина. Возвращает статус и местонахождение — ровно то, что этот сотрудник видит на экране.',
      input_schema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'Код без лишних слов' } },
        required: ['code'],
      },
      run: async (input) => {
        const code = str(input, 'code');
        if (!code) return 'пустой код';
        const { botLookup } = await import('../../wms/bot/lookup');
        return (await botLookup(actor, code)) ?? 'ничего не найдено по этому коду';
      },
    },
    {
      name: 'search',
      description:
        'Поиск по системе: клиенты, лиды, сделки, партии, контрагенты, коробки, приходы — по тексту или последним цифрам телефона. Отвечает только тем, что доступно этому сотруднику.',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      run: async (input) => {
        const text = str(input, 'text');
        if (text.length < 2) return 'запрос слишком короткий';
        const { globalSearch } = await import('../../wms/search/service');
        const hits = await globalSearch(actor, text);
        if (hits.length === 0) return 'ничего не найдено';
        return hits
          .map((hit) => `${hit.kind}: ${hit.code}${hit.label ? ` — ${hit.label}` : ''}`)
          .join('\n');
      },
    },
    {
      name: 'my_day',
      description: 'Задачи и звонки этого сотрудника на сегодня (то же, что кнопка «Bugun»).',
      input_schema: { type: 'object', properties: {} },
      run: async () => (await composeMyDayText(actor.id)) ?? 'Bugunga ochiq vazifa yo‘q.',
    },
  ];

  if (!isAnalyst(actor)) return tools;

  tools.push(
    {
      name: 'run_sql',
      description:
        `Один SELECT по базе (PostgreSQL). Только чтение, максимум ${ANALYST_ROW_CAP} строк, один оператор без «;» и комментариев. Схема и правила — в системном промпте; их нарушение вернёт правдоподобно неверные цифры.`,
      input_schema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
      run: async (input) => {
        const result = await runAnalystSql(str(input, 'sql'));
        if (!result.ok) return `ошибка: ${result.error}`;
        return JSON.stringify({ rows: result.rows, truncated: result.truncated });
      },
    },
    {
      name: 'cash_flow',
      description:
        'Движение денег за период (from/to, формат YYYY-MM-DD): поступления клиентов, партнёрские приход/расход, расходы по категориям. Единственный надёжный источник «сколько денег пришло/ушло».',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['from', 'to'],
      },
      run: async (input) => {
        const from = str(input, 'from');
        const to = str(input, 'to');
        if (!DATE_RE.test(from) || !DATE_RE.test(to)) return 'ошибка: даты в формате YYYY-MM-DD';
        const { cashFlow } = await import('../../wms/accounting/reports');
        return JSON.stringify(await cashFlow(from, to)).slice(0, 6000);
      },
    },
    {
      name: 'company_balance',
      description:
        'Остатки всех касс сейчас (в своей валюте и в USD по сегодняшнему курсу) и итог. Единственный надёжный источник «сколько денег в компании».',
      input_schema: { type: 'object', properties: {} },
      run: async () => {
        const { companyBalance } = await import('../../wms/accounting/reports');
        return JSON.stringify(await companyBalance()).slice(0, 6000);
      },
    },
  );

  return tools;
}
