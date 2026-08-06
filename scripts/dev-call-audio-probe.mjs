// The APK's exact wire shape, replayed against a local server: pair a device
// for the first active staff user, report one call on the first client's
// phone, then upload a fake m4a EXACTLY as Api.kt does (octet-stream part,
// Samsung-style filename with spaces and UTF-8).
import postgres from 'postgres';

const BASE = 'http://localhost:3000';
const sql = postgres(process.env.DATABASE_URL);

const [user] = await sql`SELECT id FROM users WHERE active ORDER BY created_at LIMIT 1`;
const [client] = await sql`SELECT id, client_code, phones FROM clients WHERE active AND jsonb_array_length(phones) > 0 ORDER BY client_code LIMIT 1`;
const phone = client.phones[0];
console.log('user', user.id, 'client', client.client_code, phone);

// Mint a pair code server-side (the profile button's write, done directly).
const code = 'PRB' + String(Date.now()).slice(-3).replace(/0/g, '2').replace(/1/g, '3');
const [dev] = await sql`
  INSERT INTO call_recorder_devices (id, user_id, label, pair_code, created_by)
  VALUES (gen_random_uuid(), ${user.id}, 'probe', ${code}, ${user.id}) RETURNING id`;

const paired = await fetch(`${BASE}/api/calls/pair`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pairCode: code, platform: 'android' }),
});
const { token } = await paired.json();
console.log('pair:', paired.status, token ? 'token ok' : 'NO TOKEN');

const startedAt = Date.now() - 120000;
const logs = await fetch(`${BASE}/api/calls/logs`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ calls: [{ phone, direction: 'out', startedAt, durationSec: 42 }] }),
});
console.log('logs:', logs.status, JSON.stringify(await logs.json()));

// A minimal valid-magic m4a: [4-byte size]['ftyp']... — the sniffer reads ftyp at offset 4.
const body = Buffer.concat([
  Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.from('M4A mp42isom'),
  Buffer.alloc(2048, 7),
]);
// EXACTLY Api.kt's multipart: octet-stream part, CRLFs, chunked-ish body.
const boundary = '----gsrcalls' + Date.now();
const name = `Qo'ng'iroq yozuvi ${phone}_260806_211530.m4a`;
const parts = Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="phone"\r\n\r\n${phone}\r\n`),
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="startedAt"\r\n\r\n${startedAt}\r\n`),
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${name.replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
  body,
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);
const up = await fetch(`${BASE}/api/calls/audio`, {
  method: 'POST',
  headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
  body: parts,
});
console.log('audio:', up.status, JSON.stringify(await up.json()));

const rows = await sql`SELECT file_name, content_type, size_bytes FROM attachments WHERE entity_type = 'call_log' ORDER BY created_at DESC LIMIT 2`;
console.log('attachments:', JSON.stringify(rows));
// Clean the probe rows out (device + call + attachment).
const calls = await sql`DELETE FROM call_logs WHERE device_id = ${dev.id} RETURNING attachment_id`;
for (const c of calls) if (c.attachment_id) await sql`DELETE FROM attachments WHERE id = ${c.attachment_id}`;
await sql`DELETE FROM call_recorder_devices WHERE id = ${dev.id}`;
await sql.end();
