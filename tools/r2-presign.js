// ============================================================================
// R2 PRESIGNED URLS — zero-dependency (uses only Node's built-in `crypto`)
// ----------------------------------------------------------------------------
// TEST HELPER ONLY. The live copy of this signer lives inside server.js (the
// server stays one file). This standalone copy lets tools/r2-smoke-test.js run
// without starting the server. If you change the signer, change both.
//
// WHAT A PRESIGNED URL IS
//   A normal web address plus a few extra query parameters, one of which is a
//   signature computed from our secret key. R2 recomputes that signature when
//   the request arrives; if it matches and hasn't expired, R2 allows exactly
//   that one operation (e.g. PUT this file at this path). The phone never sees
//   the secret — only the signed address, which dies after `expiresIn` seconds.
//
// THE SIGNING SCHEME ("AWS Signature Version 4", or SigV4)
//   R2 speaks Amazon S3's protocol, so it uses Amazon's signing recipe:
//     1. Write the request in a strict "canonical" text form.
//     2. Hash that text, wrap it in a "string to sign".
//     3. Derive a signing key from the secret by chaining HMACs over
//        date -> region -> service -> "aws4_request".
//     4. HMAC the string-to-sign with that key. That hex string is the signature.
//   Every byte matters: one wrong space or encoding and R2 answers 403.
// ============================================================================

const crypto = require('crypto');

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

// AWS wants strict RFC 3986 encoding. encodeURIComponent leaves ! ' ( ) * alone,
// so we encode those too.
function awsEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// "20261019T231500Z" and "20261019"
function amzDates(now) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Build a presigned URL.
 * @param {object} o
 *   method          'PUT' | 'GET' | 'HEAD'
 *   host            e.g. '<accountid>.r2.cloudflarestorage.com'
 *   path            e.g. '/my-bucket/records/abc/def.jpg' (unencoded)
 *   region          'auto' for R2
 *   accessKeyId, secretAccessKey
 *   expiresIn       seconds (max 604800 = 7 days)
 *   now             Date (injectable so tests are reproducible)
 */
function presignUrl(o) {
  const now = o.now || new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${o.region}/s3/aws4_request`;

  // Encode each path segment, keep the slashes between them.
  const canonicalUri = o.path.split('/').map(awsEncode).join('/');

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${o.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(o.expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${awsEncode(k)}=${awsEncode(params[k])}`)
    .join('&');

  // Only the Host header is signed, and the body is not hashed
  // (UNSIGNED-PAYLOAD) — that's what lets the phone send any bytes it likes
  // to this one path. Integrity of the bytes is handled by the SHA-256 in the
  // file name and the Media row, not by the signature.
  const canonicalRequest = [
    o.method,
    canonicalUri,
    canonicalQuery,
    `host:${o.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + o.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, o.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return `https://${o.host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ============================================================================
// R2 CONFIG — read from env vars (Render dashboard / local .env)
// ============================================================================
function r2Config(env) {
  const c = {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
  };
  c.configured = Boolean(c.accountId && c.accessKeyId && c.secretAccessKey && c.bucket);
  c.host = c.accountId ? `${c.accountId}.r2.cloudflarestorage.com` : null;
  return c;
}

function r2Url(cfg, method, key, expiresIn, now) {
  return presignUrl({
    method,
    host: cfg.host,
    path: `/${cfg.bucket}/${key}`,
    region: 'auto',
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expiresIn,
    now,
  });
}

// ============================================================================
// /api/upload-url LOGIC — pure function, no HTTP. server.js wires it up.
// ----------------------------------------------------------------------------
// Request body:
//   { items: [ { recordId, sha256, contentType }, ... ] }   (team code checked
//   by the caller, the same way /api/check does it)
// Response:
//   { expiresIn, uploads: [ { recordId, sha256, key, url, contentType } ] }
//
// One call can cover many photos -> one code check for a whole batch.
// ============================================================================
const UPLOAD_TTL_SECONDS = 600; // 10 minutes
const MAX_ITEMS_PER_CALL = 25;
const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
};
// Record IDs are crypto.randomUUID() values; allow only safe characters so a
// crafted ID can't escape its folder (no "..", no slashes).
const RECORD_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function buildUploadUrls(body, cfg, now) {
  if (!cfg.configured) {
    return { status: 503, json: { error: 'Photo storage is not configured on the server (R2_* env vars).' } };
  }
  const items = body && Array.isArray(body.items) ? body.items : null;
  if (!items || items.length === 0) {
    return { status: 400, json: { error: 'No photos listed.' } };
  }
  if (items.length > MAX_ITEMS_PER_CALL) {
    return { status: 400, json: { error: `Too many photos in one request (max ${MAX_ITEMS_PER_CALL}).` } };
  }

  const uploads = [];
  for (const [i, it] of items.entries()) {
    const recordId = String(it.recordId || '');
    const sha = String(it.sha256 || '').toLowerCase();
    const ext = ALLOWED_TYPES[it.contentType];
    if (!RECORD_ID_RE.test(recordId)) return { status: 400, json: { error: `Photo ${i + 1}: bad record ID.` } };
    if (!SHA256_RE.test(sha)) return { status: 400, json: { error: `Photo ${i + 1}: bad SHA-256.` } };
    if (!ext) return { status: 400, json: { error: `Photo ${i + 1}: unsupported type ${it.contentType}.` } };

    // Content-addressed: the file is named by its own fingerprint.
    const key = `records/${recordId}/${sha}.${ext}`;
    uploads.push({
      recordId,
      sha256: sha,
      key,
      contentType: it.contentType,
      url: r2Url(cfg, 'PUT', key, UPLOAD_TTL_SECONDS, now),
    });
  }
  return { status: 200, json: { expiresIn: UPLOAD_TTL_SECONDS, uploads } };
}

module.exports = { presignUrl, r2Config, r2Url, buildUploadUrls, sha256hex };
