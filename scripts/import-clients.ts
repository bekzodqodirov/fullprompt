import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { clients, roles, userRoles, users } from '../src/modules/platform/db/schema';
import { createClient, ClientError } from '../src/modules/platform/clients/service';
import { markDuplicates, parseTsv, type ParsedClientRow } from '../src/modules/platform/clients/import';
import { listFields, saveField, setFieldValues } from '../src/modules/wms/crm/fields';

/**
 * Bulk import of the owner's client spreadsheet.
 *
 * DRY RUN BY DEFAULT. Nothing is written until `--apply` is passed, because
 * this runs against a live database holding real cargo: a mistake here does
 * not just add bad rows, it can attach cargo to the wrong client code.
 *
 *   pnpm import-clients                       # report only
 *   pnpm import-clients --apply               # create the missing cards
 *   pnpm import-clients --apply --update      # also fix names/phones on existing ones
 *
 * Existing codes are left alone unless `--update` is given: the database is
 * the truth for a code that is already trading, and the spreadsheet is a
 * snapshot of unknown age.
 *
 * The salesperson column becomes a CRM custom field on the client card
 * ("Sotuvchi"), and is ALSO linked to a real user account when one matches by
 * name — most of these salespeople have no login yet, and inventing accounts
 * with passwords for them is the owner's decision, not a script's.
 */

const FILE = process.argv.find((arg) => arg.endsWith('.tsv')) ?? 'data/clients-import.tsv';
const APPLY = process.argv.includes('--apply');
const UPDATE = process.argv.includes('--update');
const SELLER_FIELD = 'Sotuvchi';

/** Compare staff names loosely: the sheet writes "хожакбар", the account may not. */
const foldName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '')
    .replace(/ў/g, 'у')
    .replace(/ҳ|ҷ|ҕ/g, 'х');

async function main() {
  const rows = markDuplicates(parseTsv(readFileSync(FILE, 'utf8')));
  const usable = rows.filter((row) => !row.error);
  const rejected = rows.filter((row) => row.error);

  console.log(`file: ${FILE}`);
  console.log(`rows: ${rows.length}  usable: ${usable.length}  rejected: ${rejected.length}`);

  // --- Who is already in the database ---------------------------------------
  const existing = new Map(
    (await db.select({ id: clients.id, code: clients.clientCode }).from(clients)).map((row) => [
      row.code.toUpperCase(),
      row.id,
    ]),
  );
  const toCreate = usable.filter((row) => !existing.has(row.code));
  const alreadyThere = usable.filter((row) => existing.has(row.code));

  // --- Which salespeople have a real account --------------------------------
  const staff = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(sql`${roles.code} IN ('sales_manager', 'logist', 'admin', 'super_admin')`);
  const sellers = [...new Set(usable.map((row) => row.seller).filter(Boolean))].sort();
  const sellerToUser = new Map<string, string>();
  for (const seller of sellers) {
    const match = staff.find((user) => foldName(user.fullName).includes(foldName(seller)));
    if (match) sellerToUser.set(seller, match.id);
  }

  console.log(`\nto create: ${toCreate.length}   already in the database: ${alreadyThere.length}`);
  console.log(
    `sellers: ${sellers.length} (${sellerToUser.size} matched to a login, ` +
      `${sellers.length - sellerToUser.size} will exist only as a card field)`,
  );

  const report = (label: string, list: ParsedClientRow[]) => {
    if (list.length === 0) return;
    console.log(`\n${label}:`);
    for (const row of list) {
      console.log(
        `  line ${row.line}  ${row.code || '(no code)'}  ${row.name}  ` +
          `${row.error ?? row.warning ?? ''}`.trim(),
      );
    }
  };
  report('REJECTED — fix these by hand', rejected);
  report('imported, but worth a look', usable.filter((row) => row.warning));

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to create the cards.');
    return;
  }

  // --- The seller field, so the column survives the import ------------------
  const actor = (
    await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(roles.code, 'super_admin'))
      .limit(1)
  )[0];
  if (!actor) throw new Error('no super_admin user to attribute the import to');
  const ctx = { actorId: actor.id };

  const clientFields = await listFields('client', true);
  const sellerField =
    clientFields.find((field) => field.label === SELLER_FIELD) ??
    (await saveField(
      {
        entityType: 'client',
        label: SELLER_FIELD,
        type: 'select',
        options: sellers,
        required: false,
        sortOrder: 10,
        active: true,
      },
      ctx,
    ));
  // A seller who appears only in the sheet must still be selectable.
  const knownOptions = Array.isArray(sellerField.options) ? (sellerField.options as string[]) : [];
  const missingOptions = sellers.filter((seller) => !knownOptions.includes(seller));
  if (missingOptions.length > 0) {
    await saveField(
      {
        id: sellerField.id,
        entityType: 'client',
        label: SELLER_FIELD,
        type: 'select',
        options: [...knownOptions, ...missingOptions],
        required: false,
        sortOrder: sellerField.sortOrder,
        active: true,
      },
      ctx,
    );
  }

  let created = 0;
  let updated = 0;
  const failed: { row: ParsedClientRow; reason: string }[] = [];

  for (const row of usable) {
    const known = existing.get(row.code);
    try {
      let clientId = known;
      if (!known) {
        const client = await createClient(
          {
            clientCode: row.code,
            name: row.name,
            phones: row.phone ? [row.phone] : [],
            salesManagerId: sellerToUser.get(row.seller),
            notes: row.seller ? `Sotuvchi: ${row.seller}` : undefined,
          },
          ctx,
        );
        clientId = client.id;
        created += 1;
      } else if (UPDATE) {
        await db
          .update(clients)
          .set({
            name: row.name,
            phones: row.phone ? [row.phone] : [],
            salesManagerId: sellerToUser.get(row.seller) ?? null,
          })
          .where(eq(clients.id, known));
        updated += 1;
      }
      if (clientId && row.seller) {
        await setFieldValues('client', clientId, { [sellerField.id]: row.seller }, ctx);
      }
    } catch (err) {
      failed.push({
        row,
        reason: err instanceof ClientError ? err.code : String((err as Error).message),
      });
    }
  }

  console.log(`\ncreated: ${created}   updated: ${updated}   failed: ${failed.length}`);
  for (const { row, reason } of failed) {
    console.log(`  line ${row.line}  ${row.code}  ${reason}`);
  }

  const unmatched = sellers.filter((seller) => !sellerToUser.has(seller));
  if (unmatched.length > 0) {
    console.log(
      `\nThese salespeople have no login yet, so their clients carry the name in the ` +
        `"${SELLER_FIELD}" field but no assigned manager:\n  ${unmatched.join(', ')}`,
    );
    console.log('Create the accounts, then re-run with --apply --update to link them.');
  }
}

main()
  .then(() => pgClient.end())
  .catch(async (err) => {
    console.error(err);
    await pgClient.end();
    process.exit(1);
  });
