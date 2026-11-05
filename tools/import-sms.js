#!/usr/bin/env node
/* ===========================================================================
 * tools/import-sms.js  —  one-time import of a group text into the Chat tab
 * ---------------------------------------------------------------------------
 * Reads an "SMS Backup & Restore" .xml file (Android), keeps ONLY the group
 * threads you name, and writes:
 *   - a CSV in the standard Chat-tab format (see CHAT_COLUMNS below), ready to
 *     import into the Google Sheet's "Chat" tab;
 *   - every photo/attachment from those threads into a media folder, each file
 *     named by its own SHA-256 fingerprint (same idea as app photos);
 *   - a contacts template listing each sender's number, so you can put names
 *     to numbers and re-run.
 *
 * Nothing leaves your computer. No packages needed (plain Node 18+).
 * Keep the input and every output inside private/ (it's git-ignored).
 *
 * USAGE
 *   1. See the threads in a backup (counts only, no message text):
 *        node tools/import-sms.js private/sms-XXXX.xml --list
 *   2. Import the ones you want, each with a label:
 *        node tools/import-sms.js private/sms-XXXX.xml \
 *          --thread t-1a2b="Election day — full team" \
 *          --thread t-3c4d="Election day — core group" \
 *          --me "Jake Gruber"
 *      Optional: --contacts private/contacts.csv   (number,name per line)
 *                --out private/chat-import          (output folder)
 *
 * THE CHAT FIREWALL: these rows are COMMUNICATIONS, not observations. They go
 * on the Chat tab for the composite timeline — never into the observation
 * record, never to the drafter as fact.
 * ========================================================================= */

"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// The standard Chat-tab row. Every platform adapter (this SMS import, the
// Telegram bot later) produces exactly these columns, in this order.
const CHAT_COLUMNS = [
  "Recorded (server time)", // when this row was created (import time here)
  "Sent (platform time)",   // when the message was sent, per the phone
  "Platform",               // "sms-import", later "telegram", ...
  "Chat",                   // which conversation (your label)
  "Sender",                 // name if known, else the number
  "Sender ID",              // stable ID: normalized phone number here
  "Message",                // the text
  "Attachment",             // e.g. "image/jpeg sha256:<hash>" (; separated)
  "Message ID",             // stable ID for de-duplication
];

// ---- command line ----------------------------------------------------------
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--") && !isOptionValue(a));
if (!input) die("Give the backup file: node tools/import-sms.js private/sms-XXXX.xml --list");
const opt = { threads: {}, list: false, me: "Me (export owner)", contacts: null, out: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--list") opt.list = true;
  else if (a === "--me") opt.me = args[++i];
  else if (a === "--contacts") opt.contacts = args[++i];
  else if (a === "--out") opt.out = args[++i];
  else if (a === "--thread") {
    const v = args[++i] || "";
    const eq = v.indexOf("=");
    const id = eq === -1 ? v : v.slice(0, eq);
    opt.threads[id.trim()] = eq === -1 ? id.trim() : v.slice(eq + 1).trim();
  }
}
function isOptionValue(a) {
  const i = args.indexOf(a);
  return i > 0 && ["--me", "--contacts", "--out", "--thread"].includes(args[i - 1]);
}
function die(msg) { console.error("\n  " + msg + "\n"); process.exit(1); }

// ---- tiny XML reader (just enough for SMS Backup & Restore files) ----------
// Attribute values can contain almost anything except a bare double quote, so
// we read tags attribute-by-attribute instead of guessing where ">" is.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENT[e]
  );
}
// Values are normally in double quotes, but a value that itself contains a
// double quote is written in single quotes (e.g. text='She said "hi"').
const ATTR = /\s*([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
// Read the attributes of the tag whose name ends at `pos`. Returns
// { attrs, end, selfClosing }.
function readAttrs(xml, pos) {
  const attrs = {};
  ATTR.lastIndex = pos;
  let m;
  while ((m = ATTR.exec(xml))) {
    attrs[m[1]] = decode(m[2] !== undefined ? m[2] : m[3]);
    pos = ATTR.lastIndex;
  }
  while (/\s/.test(xml[pos])) pos++;
  if (xml.startsWith("/>", pos)) return { attrs, end: pos + 2, selfClosing: true };
  if (xml[pos] === ">") return { attrs, end: pos + 1, selfClosing: false };
  throw new Error("Unexpected XML near character " + pos);
}
function* children(xml, tag, from, to) {
  const open = "<" + tag;
  let i = from;
  while ((i = xml.indexOf(open, i)) !== -1 && i < to) {
    const after = xml[i + open.length];
    if (!/[\s/>]/.test(after)) { i += open.length; continue; }
    const r = readAttrs(xml, i + open.length);
    yield r.attrs;
    i = r.end;
  }
}
function* messages(xml) {
  const re = /<(sms|mms)[\s/>]/g;
  let m;
  while ((m = re.exec(xml))) {
    const kind = m[1];
    const r = readAttrs(xml, m.index + 1 + kind.length);
    let inner = { from: r.end, to: r.end };
    if (!r.selfClosing) {
      const close = xml.indexOf("</" + kind + ">", r.end);
      if (close === -1) throw new Error("Unclosed <" + kind + "> near character " + m.index);
      inner = { from: r.end, to: close };
      re.lastIndex = close;
    } else re.lastIndex = r.end;
    const msg = { kind, a: r.attrs, parts: [], addrs: [] };
    if (kind === "mms") {
      for (const p of children(xml, "part", inner.from, inner.to)) msg.parts.push(p);
      for (const ad of children(xml, "addr", inner.from, inner.to)) msg.addrs.push(ad);
    }
    yield msg;
  }
}

// ---- helpers ---------------------------------------------------------------
// Phone numbers arrive as +14145551234, 414-555-1234, (414) 555 1234 ... Keep the
// last 10 digits so the same person always gets the same ID.
function norm(n) {
  const d = String(n || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}
function threadKey(address) {
  return String(address || "")
    .split(/[~,;]/).map(norm).filter(Boolean).sort().join("~");
}
function threadId(key) {
  return "t-" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 4);
}
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
const EXT = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/heic": "heic", "image/heif": "heif", "image/webp": "webp",
  "video/mp4": "mp4", "video/3gpp": "3gp", "audio/amr": "amr", "audio/mp4": "m4a",
  "text/vcard": "vcf", "text/x-vcard": "vcf", "application/pdf": "pdf",
};
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

// ---- read the backup -------------------------------------------------------
if (!fs.existsSync(input)) die("File not found: " + input);
const xml = fs.readFileSync(input, "utf8");

// Pass 1: group by thread.
const threads = new Map();
for (const msg of messages(xml)) {
  const key = threadKey(msg.a.address);
  if (!threads.has(key)) threads.set(key, { key, id: threadId(key), msgs: [] });
  threads.get(key).msgs.push(msg);
}

const fmtCT = (ms) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });

if (opt.list || !Object.keys(opt.threads).length) {
  console.log("\n  Threads in " + path.basename(input) + " (no message text shown):\n");
  const rows = [...threads.values()].sort((a, b) => b.msgs.length - a.msgs.length);
  for (const t of rows) {
    const dates = t.msgs.map((m) => Number(m.a.date) || 0).filter(Boolean);
    const imgs = t.msgs.reduce((n, m) => n + m.parts.filter((p) => /^image\//.test(p.ct || "")).length, 0);
    const people = t.key ? t.key.split("~").length : 0;
    console.log(
      `  ${t.id}   ${String(people).padStart(2)} number(s)   ${String(t.msgs.length).padStart(4)} msgs   ` +
      `${String(imgs).padStart(3)} photos   ${fmtCT(Math.min(...dates))}  →  ${fmtCT(Math.max(...dates))}`
    );
  }
  console.log("\n  Import with:  --thread <id>=\"Label\"  (repeat for each thread)\n");
  process.exit(0);
}

// ---- import the chosen threads ---------------------------------------------
for (const id of Object.keys(opt.threads)) {
  if (![...threads.values()].some((t) => t.id === id)) die("No thread with ID " + id + " — run with --list to see IDs.");
}

const names = new Map();
if (opt.contacts) {
  if (!fs.existsSync(opt.contacts)) die("Contacts file not found: " + opt.contacts);
  for (const line of fs.readFileSync(opt.contacts, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*"?([^",]+)"?\s*,\s*"?([^"]*)"?\s*$/);
    if (m && norm(m[1]) && m[2].trim()) names.set(norm(m[1]), m[2].trim());
  }
}

const outDir = opt.out || path.join(path.dirname(input), "chat-import");
const mediaDir = path.join(outDir, "media");
fs.mkdirSync(mediaDir, { recursive: true });

const recorded = new Date().toISOString();
const rows = [];
const senderCounts = new Map();
const seenIds = new Set();
let mediaCount = 0, dupes = 0;

for (const t of threads.values()) {
  const label = opt.threads[t.id];
  if (!label) continue;
  for (const msg of t.msgs) {
    const a = msg.a;
    const sentMs = Number(a.date) || 0;
    const outgoing = String(a.type) === "2" || String(a.msg_box) === "2";

    // Who sent it. SMS: the address is the other party. MMS: the addr with
    // type 137 is the sender. Outgoing messages are the export owner.
    let senderId = "";
    if (outgoing) senderId = "me";
    else if (msg.kind === "sms") senderId = norm(a.address);
    else {
      const from = msg.addrs.find((x) => String(x.type) === "137");
      senderId = from ? norm(from.address) : "";
    }
    const sender = senderId === "me" ? opt.me : names.get(senderId) || (senderId ? "+1 " + senderId : "(unknown)");
    if (senderId && senderId !== "me") senderCounts.set(senderId, (senderCounts.get(senderId) || 0) + 1);

    // Text and attachments.
    let text = msg.kind === "sms" ? a.body || "" : "";
    const attach = [];
    for (const p of msg.parts) {
      const ct = (p.ct || "").toLowerCase();
      if (ct === "application/smil") continue;          // layout instructions, not content
      if (ct === "text/plain") { text += (text ? "\n" : "") + (p.text || ""); continue; }
      if (!p.data) { attach.push(ct + " (no data in backup)"); continue; }
      const buf = Buffer.from(p.data, "base64");
      const h = sha256(buf);
      const file = h + "." + (EXT[ct] || "bin");
      const dest = path.join(mediaDir, file);
      if (!fs.existsSync(dest)) { fs.writeFileSync(dest, buf); mediaCount++; }
      attach.push(ct + " sha256:" + h);
    }

    // A stable ID: the same message imported twice (or re-run) gets the same ID.
    const mid = "sms-" + sha256([label, sentMs, senderId, text, attach.join(";")].join("␟")).slice(0, 16);
    if (seenIds.has(mid)) { dupes++; continue; }
    seenIds.add(mid);

    rows.push({
      sentMs,
      cells: [
        recorded,
        sentMs ? new Date(sentMs).toISOString() : "",
        "sms-import",
        label,
        sender,
        senderId === "me" ? "me" : senderId,
        text,
        attach.join("; "),
        mid,
      ],
    });
  }
}

rows.sort((x, y) => x.sentMs - y.sentMs);
const csv = [CHAT_COLUMNS, ...rows.map((r) => r.cells)].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const csvPath = path.join(outDir, "chat-rows.csv");
fs.writeFileSync(csvPath, "﻿" + csv); // BOM so Sheets/Excel read it as UTF-8 (emoji, accents)

// Contacts template: every number seen, most active first. Fill in names,
// save as contacts.csv, re-run with --contacts.
const tpl = ["number,name"].concat(
  [...senderCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => `${n},${names.get(n) || ""}`)
).join("\r\n") + "\r\n";
fs.writeFileSync(path.join(outDir, "contacts-template.csv"), tpl);

console.log(`\n  Imported ${rows.length} messages from ${Object.keys(opt.threads).length} thread(s)` +
  (dupes ? ` (${dupes} exact duplicates skipped)` : "") + ".");
console.log(`  Attachments saved: ${mediaCount} new file(s) in ${mediaDir}`);
console.log(`  Chat rows:         ${csvPath}`);
console.log(`  Senders:           ${senderCounts.size} numbers (+ you) — names: ${names.size ? names.size + " from contacts file" : "none yet; see contacts-template.csv"}\n`);
