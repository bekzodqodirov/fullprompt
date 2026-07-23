/**
 * HTTPS wrapper for local/LAN use: phones only allow the camera on secure
 * origins, so `pnpm start:https` runs the production standalone server on
 * :3000 and a TLS proxy on :3443 with a self-signed certificate (generated
 * once into .data/certs, includes the machine's LAN IPs). On the phone open
 * https://<LAN-IP>:3443 and accept the certificate warning once.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';

const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 3443);
const APP_PORT = Number(process.env.PORT ?? 3000);

function lanIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

async function loadOrCreateCert() {
  const dir = path.resolve('.data/certs');
  const keyPath = path.join(dir, 'local.key');
  const certPath = path.join(dir, 'local.crt');
  const metaPath = path.join(dir, 'local.json');
  const ips = lanIps();
  if (existsSync(keyPath) && existsSync(certPath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    // Regenerate when the machine's IPs changed (new Wi-Fi network).
    if (ips.every((ip) => meta.ips?.includes(ip))) {
      return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    }
  }
  const attrs = [{ name: 'commonName', value: 'gsr-local' }];
  const pems = await selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...ips.map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);
  writeFileSync(metaPath, JSON.stringify({ ips }));
  return { key: pems.private, cert: pems.cert };
}

const { key, cert } = await loadOrCreateCert();

const proxy = https.createServer({ key, cert }, (req, res) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: APP_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, 'x-forwarded-proto': 'https' },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end('app is starting…');
  });
  req.pipe(upstream);
});

proxy.listen(HTTPS_PORT, () => {
  console.log(`\n  🔒 HTTPS tayyor:`);
  console.log(`     kompyuterda:  https://localhost:${HTTPS_PORT}`);
  for (const ip of lanIps()) console.log(`     telefonda:    https://${ip}:${HTTPS_PORT}`);
  console.log(`     (brauzer sertifikat haqida ogohlantirsa — "Advanced" → "Proceed")\n`);
});

// Start the production app itself.
await import('./start-standalone.mjs');
