// ============================================================================
// R2 SMOKE TEST — run on your laptop, from the harness (elections) folder:
//     node tools/r2-smoke-test.js
// Reads the four R2_* values from the .env in the folder you run it from.
// Uses tools/r2-presign.js, a standalone copy of the signer in server.js.
//
// What it proves, in order:
//   1. Our signer produces URLs R2 accepts         (PUT succeeds)
//   2. The file actually landed                     (HEAD finds it)
//   3. The bytes came back unchanged                (GET + SHA-256 match)
//   4. A tampered URL is refused                    (403 = security works)
// It uploads one tiny self-labelled test image under records/SMOKETEST-.../
// so it can never be mistaken for a real observation photo.
// ============================================================================

const fs = require('fs');
const crypto = require('crypto');
const { r2Config, r2Url } = require('./r2-presign');

// --- tiny .env loader (same idea as server.js) ------------------------------
try {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — fall back to real env vars */ }

const cfg = r2Config(process.env);
if (!cfg.configured) {
  console.error('FAIL  R2 not configured. Need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET in .env');
  process.exit(1);
}

// A real 1x1 PNG, so the content type is honest.
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const key = `records/SMOKETEST-${stamp}/${sha}.png`;

(async () => {
  console.log(`Bucket: ${cfg.bucket}   Key: ${key}\n`);

  // 1. PUT
  const put = await fetch(r2Url(cfg, 'PUT', key, 600), {
    method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes,
  });
  if (!put.ok) {
    console.error(`FAIL  PUT -> ${put.status}\n${await put.text()}`);
    console.error('\n403 usually means a wrong key/secret/account ID; 404 means wrong bucket name.');
    process.exit(1);
  }
  console.log(`PASS  PUT  -> ${put.status} (upload accepted)`);

  // 2. HEAD
  const head = await fetch(r2Url(cfg, 'HEAD', key, 600), { method: 'HEAD' });
  if (!head.ok) { console.error(`FAIL  HEAD -> ${head.status}`); process.exit(1); }
  console.log(`PASS  HEAD -> ${head.status} (object exists, ${head.headers.get('content-length')} bytes)`);

  // 3. GET + hash
  const get = await fetch(r2Url(cfg, 'GET', key, 600));
  const back = Buffer.from(await get.arrayBuffer());
  const backSha = crypto.createHash('sha256').update(back).digest('hex');
  if (backSha !== sha) { console.error('FAIL  GET bytes do not match what was uploaded'); process.exit(1); }
  console.log('PASS  GET  -> bytes match, SHA-256 identical');

  // 4. Tamper: change the last character of the signature
  const good = r2Url(cfg, 'GET', key, 600);
  const bad = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
  const t = await fetch(bad);
  if (t.status !== 403) { console.error(`FAIL  tampered URL returned ${t.status}, expected 403`); process.exit(1); }
  console.log('PASS  tampered signature -> 403 (R2 refuses forged URLs)');

  console.log(`\nAll good. You can delete the test object in the dashboard: ${key}`);
})().catch((e) => { console.error('FAIL  network error:', e.message); process.exit(1); });
