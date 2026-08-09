/**
 * Mint the FIRST account on a brand-new installation.
 *
 * This exists because the demo data left the production seed (round 83). That
 * was right — a live company must never be given accounts with a published
 * password — but it took the only way IN with it: a freshly bootstrapped
 * server had every permission, role and setting and not one person to sign in
 * as. `ops/bootstrap.sh` used to print the demo login, which is now a lie.
 *
 *   pnpm create-admin +998901234567 "Bekzod"
 *
 * The password is GENERATED and printed once. Not asked for on the command
 * line, because a password typed as an argument goes into the shell history
 * and into every process list on the machine; not defaulted to anything,
 * because a default is a published password by another name.
 *
 * Refuses if any account already exists — this is a bootstrap, not a way to
 * add staff, and the /admin/users screen is where people are added.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { roles, userRoles, users } from '../src/modules/platform/db/schema';
import { hashPassword } from '../src/modules/platform/auth/password';

/** No look-alike characters: this gets read off a terminal and typed on a phone. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(length = 14): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

async function main() {
  const phone = (process.argv[2] ?? '').trim();
  const fullName = (process.argv[3] ?? '').trim();
  if (!/^\+?\d{9,15}$/.test(phone) || fullName.length < 2) {
    console.error('Ishlatilishi: pnpm create-admin +998901234567 "Ism Familiya"');
    process.exitCode = 1;
    return;
  }

  const [countRow] = await db.select({ n: sql<number>`count(*)` }).from(users);
  const n = Number(countRow?.n ?? 0);
  if (n > 0) {
    console.error(
      `Bazada allaqachon ${n} ta hisob bor — bu skript faqat bo'sh baza uchun. ` +
        "Yangi xodimni Boshqaruv → Xodimlar sahifasidan qo'shing.",
    );
    process.exitCode = 1;
    return;
  }

  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  if (!role) {
    console.error('Rollar hali yaratilmagan — avval `pnpm db:seed` ni ishlating.');
    process.exitCode = 1;
    return;
  }

  const password = generatePassword();
  const [row] = await db
    .insert(users)
    .values({ phone, fullName, passwordHash: await hashPassword(password), locale: 'uz' })
    .returning({ id: users.id });
  await db.insert(userRoles).values({ userId: row!.id, roleId: role.id });

  console.log('');
  console.log('  Super-admin yaratildi.');
  console.log(`    Telefon: ${phone}`);
  console.log(`    Parol:   ${password}`);
  console.log('');
  console.log('  Bu parol BOSHQA hech qayerda saqlanmaydi — hozir yozib oling,');
  console.log("  kirgach Profil sahifasidan o'zingiznikiga almashtiring.");
  console.log('');
}

main()
  .then(() => pgClient.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
