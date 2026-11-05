#!/usr/bin/env node
/* ===========================================================================
 * tools/telegram-setup.js  —  set up (and check on) the team-chat bot
 * ---------------------------------------------------------------------------
 * You run this on YOUR computer, from the repo folder. It talks to Telegram's
 * Bot API using the bot token in your local .env. The token never goes to
 * Render — the server doesn't need it in v1.
 *
 * Needs in .env (git-ignored):
 *   TELEGRAM_BOT_TOKEN       from @BotFather (looks like 123456:ABC-xyz...)
 *   TELEGRAM_WEBHOOK_SECRET  run "secret" below to make one; the SAME value
 *                            goes on Render
 *
 * COMMANDS (in the order you'll use them)
 *   node tools/telegram-setup.js secret     make a random webhook secret
 *   node tools/telegram-setup.js whoami     check the token; confirm the bot
 *                                           can read ALL group messages
 *   node tools/telegram-setup.js chats      list groups the bot has seen, with
 *                                           their chat IDs (only works while
 *                                           NO webhook is set)
 *   node tools/telegram-setup.js set https://YOUR-APP.onrender.com
 *                                           point Telegram at /api/chat-hook
 *   node tools/telegram-setup.js info       is the webhook healthy? last error?
 *   node tools/telegram-setup.js delete     remove the webhook (messages then
 *                                           wait at Telegram ~24h)
 *
 * No packages needed (plain Node 18+).
 * ========================================================================= */

"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadDotEnv(path.join(__dirname, "..", ".env"));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const [cmd, arg] = process.argv.slice(2);

main().catch((e) => die(String(e && e.message || e)));

async function main() {
  if (cmd === "secret") {
    // Telegram allows A-Z a-z 0-9 _ - in a secret, up to 256 characters.
    // 32 random bytes as hex = 64 characters, all allowed.
    const s = crypto.randomBytes(32).toString("hex");
    console.log(`\n  New webhook secret (put it in .env AND on Render):\n\n  TELEGRAM_WEBHOOK_SECRET=${s}\n`);
    return;
  }

  if (!TOKEN) die("No TELEGRAM_BOT_TOKEN in .env. Get it from @BotFather (/newbot).");

  if (cmd === "whoami") {
    const me = await api("getMe");
    console.log(`\n  Bot: ${me.first_name} (@${me.username}), id ${me.id}`);
    console.log(`  Can join groups:            ${me.can_join_groups ? "yes" : "no (fine once it's in the team group)"}`);
    console.log(`  Reads ALL group messages:   ${me.can_read_all_group_messages ? "yes ✅" : "NO ❌ — privacy mode is ON"}`);
    if (!me.can_read_all_group_messages) {
      console.log(`\n  Fix: @BotFather -> /setprivacy -> pick the bot -> Disable.`);
      console.log(`  Then REMOVE the bot from the group and ADD it again — the change`);
      console.log(`  only applies to groups the bot joins afterwards.`);
    }
    console.log("");
    return;
  }

  if (cmd === "chats") {
    // getUpdates is Telegram's "pull" mode. It refuses while a webhook is set,
    // and it only sees messages from roughly the last 24 hours.
    const hook = await api("getWebhookInfo");
    if (hook.url) die(`A webhook is set (${hook.url}), so Telegram won't hand updates out here.\n  Look in the Render logs instead for "ignoring message from chat <ID>",\n  or run "delete" first, then post in the group, then "chats".`);
    const ups = await api("getUpdates", { allowed_updates: ["message", "edited_message", "my_chat_member"] });
    const chats = new Map();
    for (const u of ups) {
      const m = u.message || u.edited_message || u.my_chat_member;
      if (m && m.chat) chats.set(String(m.chat.id), m.chat);
    }
    if (!chats.size) {
      console.log("\n  No chats seen yet. Post a message in the team group, then run this again.\n");
      return;
    }
    console.log("\n  Chats the bot has seen recently:\n");
    for (const [id, c] of chats) console.log(`    ${id.padEnd(16)} ${c.type.padEnd(11)} ${c.title || c.username || c.first_name || ""}`);
    console.log(`\n  Put the team group's ID in TELEGRAM_CHAT_IDS on Render (comma-separate several).`);
    console.log(`  Group IDs are negative numbers — keep the minus sign.\n`);
    return;
  }

  if (cmd === "set") {
    if (!SECRET) die("No TELEGRAM_WEBHOOK_SECRET in .env. Run: node tools/telegram-setup.js secret");
    if (!arg || !/^https:\/\//.test(arg)) die("Give the app's https address: node tools/telegram-setup.js set https://your-app.onrender.com");
    const url = arg.replace(/\/+$/, "") + "/api/chat-hook";
    await api("setWebhook", {
      url,
      secret_token: SECRET,                       // sent back on every delivery
      allowed_updates: ["message", "edited_message"],
      max_connections: 1,                          // one at a time = rows stay in order
      drop_pending_updates: false,                 // keep anything already waiting
    });
    console.log(`\n  Webhook set -> ${url}`);
    console.log(`  Now post a test message in the group and run "info".\n`);
    return;
  }

  if (cmd === "info") {
    const h = await api("getWebhookInfo");
    console.log(`\n  Webhook URL:       ${h.url || "(none set)"}`);
    console.log(`  Waiting to send:   ${h.pending_update_count}`);
    console.log(`  Max connections:   ${h.max_connections || "-"}`);
    console.log(`  Allowed updates:   ${(h.allowed_updates || ["(default)"]).join(", ")}`);
    if (h.last_error_date) {
      console.log(`  Last error:        ${new Date(h.last_error_date * 1000).toLocaleString()} — ${h.last_error_message}`);
      console.log(`  (A past error is fine if "Waiting to send" is 0 — Telegram retried and got through.)`);
    } else {
      console.log(`  Last error:        none`);
    }
    console.log("");
    return;
  }

  if (cmd === "delete") {
    await api("deleteWebhook", { drop_pending_updates: false });
    console.log("\n  Webhook removed. Messages now wait at Telegram (about 24h) until it's set again.\n");
    return;
  }

  die("Commands: secret | whoami | chats | set <https://app-url> | info | delete");
}

async function api(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(`Telegram ${method} failed: ${d.description || "HTTP " + r.status}`);
  return d.result;
}

function die(msg) { console.error("\n  " + msg + "\n"); process.exit(1); }

// Same tiny .env reader as server.js.
function loadDotEnv(p) {
  try {
    if (!fs.existsSync(p)) return;
    for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) { /* no .env is fine for "secret" */ }
}
