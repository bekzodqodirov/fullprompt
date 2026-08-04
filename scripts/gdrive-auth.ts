import { createInterface } from 'node:readline/promises';

/**
 * One-time: turn a Google OAuth client into a refresh token for the server.
 *
 * Run by the OWNER, on his own machine, once. It prints a link, he approves
 * it in his browser, pastes back the code, and it prints the two lines to add
 * to the server `.env`. Nothing is written to disk and nothing leaves his
 * terminal — the secret belongs in the gitignored server `.env` and nowhere
 * else, least of all in this repository.
 *
 * BEFORE RUNNING THIS, the app must be PUBLISHED (Google Auth Platform →
 * Audience → Publish app, status "In production"). A refresh token minted
 * while the app is still in "Testing" expires in SEVEN DAYS, and the clock is
 * set at the moment of consent — publishing afterwards does not rescue a
 * token already issued. It would work for a week and then stop, silently, and
 * the day anybody noticed would be the day a restore was needed.
 *
 * Full instructions in Uzbek: docs/BACKUP.md
 */

// The narrowest scope that can create, list and delete the app's OWN files.
// It is also classified non-sensitive, which is what allows the consent
// screen to be published with no Google verification — see gdrive.ts.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
// The documented loopback value for an installed/desktop client: Google
// shows the code on screen instead of redirecting anywhere.
const REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== GSR — Google Drive backup uchun token olish ===\n');
  console.log('Oldin bajarilgan bo‘lishi SHART (docs/BACKUP.md):');
  console.log('  · Google Cloud loyihasi + Drive API yoqilgan');
  console.log('  · OAuth klient turi: Desktop app');
  console.log('  · Google Auth Platform → Audience → PUBLISH APP bosilgan');
  console.log('    (holat "In production" bo‘lishi kerak, "Testing" EMAS)\n');

  const clientId = (await rl.question('GDRIVE_CLIENT_ID: ')).trim();
  const clientSecret = (await rl.question('GDRIVE_CLIENT_SECRET: ')).trim();
  if (!clientId || !clientSecret) {
    console.error('\nBo‘sh qiymat. To‘xtatildi.');
    rl.close();
    process.exit(1);
  }

  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: SCOPE,
      // offline → a refresh token comes back at all.
      access_type: 'offline',
      // consent → it comes back EVERY time, not only the first. Without this
      // a second run returns no refresh_token and looks broken.
      prompt: 'consent',
    });

  console.log('\n1) Shu havolani brauzerda oching va ruxsat bering:\n');
  console.log(url);
  console.log('\n2) Google bergan kodni shu yerga tashlang.\n');
  const code = (await rl.question('Kod: ')).trim();
  rl.close();

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !body.refresh_token) {
    console.error(`\n❌ Token olinmadi: ${body.error ?? res.status} ${body.error_description ?? ''}`);
    if (body.error === 'invalid_grant') {
      console.error('   Kod bir martalik va tez eskiradi — havolani qaytadan oching.');
    }
    process.exit(1);
  }

  console.log('\n✅ Bo‘ldi. Serverdagi .env fayliga shu 3 qatorni qo‘shing:\n');
  console.log(`GDRIVE_CLIENT_ID=${clientId}`);
  console.log(`GDRIVE_CLIENT_SECRET=${clientSecret}`);
  console.log(`GDRIVE_REFRESH_TOKEN=${body.refresh_token}`);
  console.log('\nSo‘ng: docker compose up -d app');
  console.log('Tekshirish: docker compose exec app node -e "…" emas — docs/BACKUP.md ga qarang.\n');
  console.log('⚠️  Bu qatorlarni hech kimga yubormang va repoga qo‘ymang.\n');
}

void main();
