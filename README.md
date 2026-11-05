# Observer Field Log & Complaint Drafter — the harness

This is a small web app your fellow observers open on their phones in the field.
They log incidents as they happen; when they're ready, one tap sends the record
to a small server you run, which drafts a formal complaint using your Election
Complaint Filing Assistant system profile and the loaded Wisconsin ch. EL 4
rules.

You are reading the operator's guide. It has three parts:

1. **How the pieces fit together** (the mental model)
2. **Run it on your own computer** (5 minutes, to see it work)
3. **Put it on the internet** so your fellows can reach it from anywhere

There is no prior web-development knowledge assumed. Where a term might be new
(environment variable, endpoint, deploy), it's explained the first time it
appears.

---

## 1. How the pieces fit together

Think of it as three things talking to each other:

```
  PHONE (the observer)                 SERVER (you run this)            ANTHROPIC
  ────────────────────                 ─────────────────────           ─────────
  public/index.html         ──POST──►  server.js                ──►    Claude API
  - logs incidents                     - holds the secret key          - reads the
  - stores them on the                 - glues system-prompt.md          system profile
    phone (localStorage)                 + knowledge/*.md into a         - writes the
  - "Draft complaint" sends              system prompt                    complaint draft
    the record to the server           - forwards to Anthropic    ◄──   returns text
                            ◄─draft──   - returns the draft
```

The important idea: **the secret API key lives only on the server.** It is never
sent to the phones. That is the whole reason there is a server instead of just a
web page — a web page can't keep a secret. A server can.

The files, and what each one is for:

| File | What it is |
|---|---|
| `server.js` | The harness. One file, no external packages. Serves the app and does the drafting call. Heavily commented — read it top to bottom. |
| `public/index.html` | The app your fellows use. Self-contained (HTML + CSS + JavaScript in one file). |
| `system-prompt.md` | Your system profile. **Edit this to change how the drafter behaves** — no code changes needed. |
| `knowledge/project_context.md` | The loaded rule corpus (EL 4 statute + observer guidance). The source of truth for citations. |
| `.env` | Where your secret key lives on your own computer. Git-ignored, never shared. You create this from `.env.example`. |
| `.env.example` | A template showing which values to set. |
| `package.json` | Tells the host how to start the app (`node server.js`) and that it needs Node 18+. |

An **environment variable** (like `ANTHROPIC_API_KEY`) is just a named value the
computer hands to the program when it starts. On your own machine it comes from
the `.env` file. On a host, you type it into a settings box. Same idea, two
places.

---

## 2. Run it on your own computer

**You need:** Node.js version 18 or newer. Check by opening a terminal and
typing `node --version`. If it prints something below v18, or "command not
found", install the current LTS from <https://nodejs.org>.

**Step 1 — Get an Anthropic API key.**
Go to <https://console.anthropic.com>, sign in, add a payment method under
Billing (drafting costs money per use — see the cost note below), then
Settings → API Keys → Create Key. Copy the key; it starts with `sk-ant-`.
Treat it like a credit-card number.

**Step 2 — Create your `.env` file.**
In this folder, make a copy of `.env.example` and name the copy `.env`. Open it
and paste your key after `ANTHROPIC_API_KEY=`. Leave the other lines as they are
for now. Save.

**Step 3 — Start the server.**
In a terminal, move into this folder and run:

```
node server.js
```

You should see "Election Complaint Harness is running" and
"API key configured: yes". There are no packages to install — that's deliberate.

**Step 4 — Open it.**
In a browser on the same computer, go to <http://localhost:3000>.
Fill in the Setup tab, log a test incident, and tap **Draft complaint**. In a
few seconds you'll get a full draft with citation markers and a Dismissal Risk
Assessment.

To stop the server, press `Ctrl + C` in the terminal.

> Tip: the **Setup → Check server status** button confirms the server sees your
> key and which model it will use.

---

## 3. Put it on the internet (so your fellows can reach it)

Running it on your laptop only works while your laptop is on and only for you.
To give your fellows a link, put it on a host that runs it around the clock.

Any host that runs a Node app works (Render, Railway, Fly.io, a small VPS). The
walkthrough below uses **Render** because it has a free tier and a simple
dashboard. The same three ideas apply anywhere: give the host the code, tell it
the start command, and set the environment variables.

**Step 1 — Put the code on GitHub.**
Create a free account at <https://github.com>, make a new repository, and upload
this whole folder to it. (GitHub's web uploader works; the `.gitignore` here
makes sure your `.env` and its secret key are *not* uploaded.)

**Step 2 — Create the service on Render.**
Sign up at <https://render.com> → **New** → **Web Service** → connect your
GitHub repo. Set:

- **Runtime:** Node
- **Build command:** *(leave blank — there are no packages to install)*
- **Start command:** `node server.js`

**Step 3 — Add your environment variables.**
In the service's **Environment** section, add:

- `ANTHROPIC_API_KEY` = your `sk-ant-...` key
- `ACCESS_CODE` = a shared password of your choice (strongly recommended — see
  below)
- optionally `MODEL` = `claude-opus-5` for highest quality, or
  `claude-haiku-4-5-20251001` for lowest cost. Default is `claude-sonnet-5`.
- optionally `SHEET_WEBHOOK_URL` to turn on central collection into a Google
  Sheet — you set this up later, see "Central collection" below.

Do **not** set `PORT` — Render provides it automatically, and the server reads
whatever the host gives it.

**Step 4 — Deploy.**
Click Create/Deploy. When it finishes, Render gives you a public URL like
`https://your-app.onrender.com`. That's the link you hand out. On a phone, open
it and use **Add to Home Screen** so it behaves like an app.

**Step 5 — Give your fellows the access code.**
If you set `ACCESS_CODE`, each fellow types it once under the app's **Setup**
tab. Without it, the server refuses to draft. This is what stops a stranger who
finds the URL from spending your API budget.

---

## Central collection (optional) — observations into a Google Sheet

By default, each observer's notes live only on their own phone. Turning this on
gives every observer a **Submit to team** button that pushes their observations
into one **Google Sheet you own**, so you have a live, durable, central record
without running a database.

How it flows: phone → your server (`/api/submit`) → a tiny Google Apps Script →
your Sheet. Your server never holds Google credentials; it just forwards to a
web-app URL that only you can create.

**Step 1 — Make the Sheet.** Create a new blank Google Sheet (sheets.new). Name
it something like "Observer Field Records". Leave it empty; the script writes
the header row for you.

**Step 2 — Add the script.** In that Sheet: **Extensions → Apps Script**. Delete
whatever sample code is there, and paste in the entire contents of
`google-apps-script.gs` (included in this project). Click the **Save** icon.

**Step 3 — Deploy it as a web app.** Click **Deploy → New deployment**. Click the
gear next to "Select type" and choose **Web app**. Set:

- **Execute as:** Me (your Google account)
- **Who has access:** Anyone

Click **Deploy**. Google will ask you to authorize it the first time — approve
it (it's your own script writing to your own sheet). When it finishes, copy the
**Web app URL**. It ends in `/exec`.

> Quick test: paste that URL into a browser. You should see
> `{"ok":true,"service":"observer-central-collection"}`. That means it's live.

**Step 4 — Tell your server about it.** In Render, add one more environment
variable:

- **Name:** `SHEET_WEBHOOK_URL`
- **Value:** the `/exec` URL you just copied

Save; Render redeploys. That's it — the **Submit to team** button now writes to
your Sheet. Confirm with **Setup → Check server status** in the app; it should
say "central collection on ✅".

**Using it.** Observers tap **Submit to team** on the Log tab. Each unsent
observation becomes a row in your Sheet (timestamped server-side, with the
observer's name and organization). The button tracks what's already been sent,
so tapping it again only sends new observations. Each observation also stays on
the observer's own phone.

**A few honest limits of the simple version:**

- Submitting is open to anyone who can reach the app (there's no separate submit
  code — observers don't use the drafter code). If your public URL is a concern,
  the app's **team-code** option (a future toggle) or host-level password
  protection would close that. For a link shared only within your team it's a
  low risk; the worst case is a junk row you can delete.
- It's one-directional: observations flow *into* the Sheet. The drafter still
  drafts from observations logged (or imported) in the app. To draft from a
  submitted observation, copy its details from the Sheet into a log entry. A
  future "robust" version could let the drafter pull submitted observations
  straight into the app.
- If you ever change the script, you must **Deploy → Manage deployments → edit →
  New version** for the change to take effect (a plain Save isn't enough for the
  live web app).

---

## Drafter read-back (optional) — draft from the whole team's repo

Central collection sends observations *into* the Sheet. This lets a drafter pull
them back *out*, straight into the Draft tab — so a drafter can build a complaint
from everyone's submissions without any file hand-off. It reads the **latest
revision** of each observation (respecting the append-only history) and
attributes each incident to the observer who logged it.

Because this turns the repo from write-only into readable, it's protected by a
**shared secret** so the data can't be pulled by anyone who finds the URL.

**Setup:**

1. In your Apps Script (the `google-apps-script.gs` you already pasted), set the
   `READ_TOKEN` value near the top to any random secret string, then
   **Deploy → Manage deployments → edit → New version → Deploy** so the change
   goes live.
2. In Render, add an environment variable **`SHEET_READ_TOKEN`** set to the
   *exact same* value. (`SHEET_WEBHOOK_URL` must already be set.)
3. Redeploy. Confirm with **Setup → Check server status** — it should show
   "drafter read-back on ✅".

**Using it:** on the Draft tab, a drafter taps **Load team observations**, checks
the ones to include (they can mix in incidents logged on their own device too),
and drafts. Each pulled observation carries its observer's name into the
Statement of Facts. The button is gated by the **drafter code**.

If the token doesn't match on both sides, the load fails with a clear message —
that mismatch is the most common snag, so double-check `READ_TOKEN` (Apps Script)
equals `SHEET_READ_TOKEN` (Render).

---

## Record view (optional) — one observation + its photos, for principals

Each observation gets a page at `https://<your-site>/r/<Record ID>` showing the
latest revision, the full revision history (what changed in each edit), and every
photo listed for it on the Media tab, with time, location and fingerprint.

- **Gate:** the drafter code (`ACCESS_CODE`). The page asks once and the browser
  remembers it. If `ACCESS_CODE` is **not** set, the page refuses to run (it fails
  closed — photos are evidence).
- **Needs:** read-back working (`SHEET_WEBHOOK_URL` + `SHEET_READ_TOKEN` + matching
  `READ_TOKEN`) and the **current** `google-apps-script.gs` (it adds the `media` read).
  An older script gets a loud "script is out of date" error, never a silent "no photos".
- **Photos:** only photos the server already verified (listed on the Media tab) are
  shown. Viewing links are signed by the server and expire after 15 minutes; the
  bucket stays private. Press Refresh for fresh links.
- **Check it's live:** `/health` shows `recordView: true`.

**Review tab in the Sheet** (a read-only mirror with a link per row). Add a new tab
named `Review` at the END of the tab list (never first — read-back reads the first
tab; never add columns to the first sheet — its schema guard will refuse submits).
Replace `Sheet1` with your first tab's actual name:

- `A1`: `={Sheet1!A:X}`
- `Y1`: `Photos` · `Y2`: `=ARRAYFORMULA(IF(A2:A="","",COUNTIF(Media!A:A,A2:A)))`
- `Z1`: `Record` · `Z2`: `=ARRAYFORMULA(IF(A2:A="","",HYPERLINK("https://web-trainstorm.onrender.com/r/"&A2:A,"Open")))`

## Team chat (optional) — the Telegram group, mirrored into the Chat tab

The team talks in a Telegram group. A bot sits in the group and copies every
message, as it arrives, onto a **Chat** tab in the Google Sheet, next to the
observations and photos. The app's Log tab gets a **💬 Team chat** button that
opens the group.

```
Telegram group ──(each message)──> server  /api/chat-hook ──> Apps Script ──> "Chat" tab
                                   (checks secret + group ID)
```

**The chat firewall.** Chat rows are communications: firsthand fact, hearsay,
opinion and logistics, all mixed. They go on the Chat tab **only**, never on the
observation sheet, and never to the drafter as fact. If someone sees something
firsthand, they log it in the app too. A complaint cites the app entry.

**What gets recorded:** text, captions, edits (each edit is a **new row**; the
original row is never changed), replies and forwards (marked in `[brackets]`),
joins and leaves, locations, and photos and files. **v1 records that a photo
was posted, plus Telegram's file handle (`tg-file:...`), but not the photo
itself.** Copying chat photos into R2 with a SHA-256 is the next layer.
Telegram does **not** tell bots about deleted messages, so a message deleted
after it was recorded stays on the Chat tab.

### Setup (once)

Do these **in order**. Steps 1 and 2 are the ones that commonly go wrong.

1. **Create the bot.** In Telegram, message **@BotFather**: `/newbot`, then
   pick a name and a username. It replies with a **token**. Treat it like a
   password. Then send `/setprivacy`, pick the bot, and choose **Disable**.
   (With privacy left on, the bot only sees /commands and @mentions, which
   means almost nothing gets recorded.)
2. **Create the group and add the bot.** Add the bot **after** you've
   disabled privacy. If you added it before, remove it and add it again,
   because the setting only applies to groups the bot joins afterwards. Make
   any group-settings changes now, before you note the ID: Telegram sometimes
   "upgrades" a group and gives it a **new chat ID**. (If that happens later,
   the server logs a loud WARNING with the new ID.) Optional: once the bot is
   in, set `/setjoingroups` → Disable in @BotFather so nobody else can add it
   to their own groups.
3. **Make an invite link.** Group → Invite links → create one. Turn on
   **Request admin approval** so a leaked link doesn't let strangers in. This
   becomes `TEAM_CHAT_URL`.
4. **Local `.env`** (git-ignored): add `TELEGRAM_BOT_TOKEN=<token>`. Then:
   ```
   node tools/telegram-setup.js secret     # paste the output into .env
   node tools/telegram-setup.js whoami     # must say "Reads ALL group messages: yes ✅"
   ```
   Post any message in the group, then:
   ```
   node tools/telegram-setup.js chats      # shows the group's chat ID (negative number)
   ```
5. **Load the Nov 3 group-text import first** (if you haven't yet). That
   import uses File → Import → *Replace current sheet* on the Chat tab, so
   running it **after** live capture starts would erase the Telegram rows.
6. **Apps Script.** Paste the new `google-apps-script.gs`, Save, then
   **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** A
   plain Save does **not** update the live `/exec` URL.
7. **Render → Environment:** add `TELEGRAM_WEBHOOK_SECRET` (same as `.env`),
   `TELEGRAM_CHAT_IDS` (the group ID, minus sign included) and `TEAM_CHAT_URL`.
   Don't add the bot token to Render; v1 doesn't need it there. Save and
   redeploy. `/health` should then show `"chatCapture": true` and
   `"teamChatButton": true`.
8. **Point Telegram at the server:**
   ```
   node tools/telegram-setup.js set https://YOUR-APP.onrender.com
   ```
9. **Test** with a self-identifying message, e.g. `TEST-JAKE chat capture
   11/05 9:14pm`. It should appear on the Chat tab within a few seconds. Edit
   it, and a second row marked `[edit of ...]` should appear. Run
   `node tools/telegram-setup.js info`. "Waiting to send" should be 0.
10. **Tell the group** that the chat is kept as team records, and that
    firsthand facts still go in the app.

### How it stays reliable

- **Nothing is lost on a hiccup.** The server only answers Telegram "OK"
  after the Sheet confirms the row. Otherwise Telegram re-sends later, for
  about 24 hours.
- **No duplicates from re-sends.** Each row carries a Message ID
  (`tg:<chat>:<message>`, and `:e<time>` for edits). The Apps Script skips any
  ID it has already written.
- **Only your group.** Messages from any chat not on `TELEGRAM_CHAT_IDS` are
  dropped (and logged with their ID, which is handy during setup).
- **Only Telegram.** Every delivery must carry the webhook secret.
- **No formula injection.** Chat cells are written as plain text, so a message
  starting with `=` can't run as a Sheet formula.
- **The server must be reachable.** If Render is asleep or down, Telegram
  holds messages and retries, but only for about a day. Keep the paid tier on
  for election days (already the plan).

## Observer rules-check (optional) — "what do you think of this?"

This gives observers a **Check the rules** box on the Log tab: they briefly
describe what they're seeing, and a model reads it against the loaded EL 4
corpus and flags — in two or three sentences — whether it might implicate a
rule, names the provision, marks its confidence, and tells them what facts to
capture. It's **advisory only**: it never files anything, it always tells the
observer to log it regardless, and its assessment is **not saved** into the
record (only the facts the observer enters when logging become the record).

It's a separate, paid AI endpoint, so it's gated by its own **team code** and
runs on a cheaper model.

**To turn it on**, add these environment variables in Render:

- `TEAM_CODE` = a shared code your members type once under the app's **Setup**
  tab. Required — without it, the check button won't work. This keeps the
  endpoint off the open internet.
- `CHECK_MODEL` = optional. Defaults to `claude-haiku-4-5-20251001` (cheap and
  fast). Set it to `claude-sonnet-5` to A/B the quality and see real cost — the
  token counts print with each check in the browser console, and every call
  shows up in your Anthropic console usage.

That's the whole setup — no new files. Observers enter the team code in Setup,
type what they see, tap **Check**, and can hit **Log this observation** to carry
their description straight into a new incident.

**Cost note:** each check sends the corpus plus a short description to the model.
The corpus is marked for **prompt caching**, so repeated checks in the same
window are much cheaper than the first. On Haiku this is a fraction of a cent per
check; on Sonnet it's a few times that. Set a monthly limit in the Anthropic
console if you want a hard ceiling before the midterm.

---

## Managing it once it's live

**Cost.** You pay Anthropic per draft, based on the model and the length of the
record + draft. With the default `claude-sonnet-5`, a typical single-incident
complaint is a fraction of a cent to a few cents of input plus output. `opus-5`
costs more per token; `haiku` costs less. Set a monthly spend limit in the
Anthropic console (Billing → Limits) so there are no surprises. The token counts
for each draft show under the generated complaint.

**Changing the drafter's behavior.** Edit `system-prompt.md` and redeploy (on
Render, push the change to GitHub and it redeploys, or click Manual Deploy). No
code changes required — the server rebuilds the system prompt from that file
every time it starts.

**Updating the rules.** Edit `knowledge/project_context.md` the same way. It is
the citation source of truth; keep it current with the statute.

**Changing the model.** Change the `MODEL` environment variable and redeploy.
Model IDs as of this build: `claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001`. If a model name is ever wrong, the app shows the
API's error (e.g. "model not found") right under the Draft button — swap the
value and redeploy.

---

## Security & responsibility notes

- The API key stays server-side and is never delivered to phones. Keep it that
  way — don't paste it into the front-end file.
- Use `ACCESS_CODE` for any public URL. It's a light gate, not a fortress; for
  anything more sensitive, put the app behind your host's password protection or
  a login.
- This tool **drafts**; it does not file, and it is not legal advice. Every
  draft carries citation-confidence markers (`[DIRECT CITATION]`, `[INFERRED]`,
  `[NOT FOUND]`) precisely so a human verifies each one against current statute
  text before filing. The Dismissal Risk Assessment is there to be read, not
  skipped.
- Observers' logged notes live on each observer's own device (localStorage) and
  in whatever JSON they export. Handle those exports the way you'd handle any
  contemporaneous field record.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Draft button says "no ANTHROPIC_API_KEY set" | The key env var isn't set (or, locally, `.env` is missing or misnamed). Set it and restart/redeploy. |
| "Anthropic API returned 401" | Wrong or revoked key. Create a fresh one. |
| "Anthropic API returned 404 ... model" | The `MODEL` value isn't a valid model ID. Use one from the list above. |
| "Anthropic API returned 400 ... credit balance" | Add a payment method / credit in the Anthropic console. |
| "Wrong or missing access code" | You set `ACCESS_CODE` on the server; enter the same code under the app's Setup tab. |
| Page loads but nothing saves | The browser is in private mode with storage blocked, or storage is full. Use a normal window. |
| Works on your laptop, not from a phone | `localhost` only works on the same machine — that's expected. Deploy (Part 3) to get a shareable URL. |

---

*Built from the Election Complaint Filing Assistant system profile, v2, and the
loaded ch. EL 4 corpus.*
