/* ===========================================================================
 * server.js  —  THE HARNESS
 * ---------------------------------------------------------------------------
 * This is the whole back end, in one file, with no external packages.
 *
 * What it does, in plain terms:
 *   1. On startup it reads two text files off disk — your system profile
 *      (system-prompt.md) and your rule corpus (knowledge/project_context.md)
 *      — and glues them together into ONE big "system prompt". That combined
 *      text is the personality + the law that the AI uses on every request.
 *   2. It serves the field-capture web app (public/index.html) to any phone or
 *      laptop that opens the site.
 *   3. When an observer taps "Draft complaint", the app sends the structured
 *      incident record here to POST /api/draft. This file forwards it to the
 *      Anthropic API together with the system prompt, waits for the draft, and
 *      sends it back to the phone.
 *
 * The one secret — your Anthropic API key — lives HERE, on the server, in an
 * environment variable. It is never sent to the phones. That is the entire
 * point of having a server instead of just a web page.
 * ========================================================================= */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto"); // built in — used to sign photo-upload links

// ---- Configuration, read from environment variables -----------------------
// An "environment variable" is just a named value the operating system hands
// to the program when it starts. Locally you set them in a .env file (loaded
// just below). On a host like Render you type them into the dashboard.
loadDotEnvIfPresent();

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.MODEL || "claude-sonnet-5";
const ACCESS_CODE = process.env.ACCESS_CODE || ""; // drafter code -> /api/draft
// Observer rules-check: a shared team code gates /api/check, and CHECK_MODEL
// picks the (cheaper) model for it. Default Haiku for speed/cost; set to
// claude-sonnet-5 to A/B the quality and see real cost before the midterm.
const TEAM_CODE = process.env.TEAM_CODE || ""; // team code -> /api/check
const CHECK_MODEL = process.env.CHECK_MODEL || "claude-haiku-4-5-20251001";
// Central collection: the URL of your Google Apps Script web app. When set,
// observers' "Submit to team" pushes rows into your Google Sheet through it.
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL || "";
// Drafter read-back: shared secret that must match READ_TOKEN in the Apps
// Script. Lets a drafter pull the team's observations back out of the Sheet.
const SHEET_READ_TOKEN = process.env.SHEET_READ_TOKEN || "";
// Photo storage (Cloudflare R2). All four must be set for photo uploads to work.
// The phone never sees these: the server uses them only to SIGN short-lived
// upload links (see "Photo storage" section below).
const R2 = r2Config(process.env);
const PORT = process.env.PORT || 3000;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Output-length ceiling for a draft. 8000 is generous for a full eight-element
// complaint + Dismissal Risk Assessment. Env-overridable so you can tune it on
// the host without a code change. NOTE: this caps how much the model may WRITE;
// it does not make short drafts long. If a draft comes back cut off, check the
// `truncated` flag we now return (see handleDraft) before assuming this is why.
const MAX_TOKENS = Number(process.env.DRAFT_MAX_TOKENS) || 8000;

// ---- Build the system prompt once, at startup ------------------------------
const PROFILE = readFileSafe(path.join(__dirname, "system-prompt.md"));
const CORPUS = readFileSafe(
  path.join(__dirname, "knowledge", "project_context.md")
);
const SYSTEM_PROMPT =
  PROFILE +
  "\n\n===========================================================\n" +
  "APPENDED SOURCE OF TRUTH — project_context.md (the loaded rule corpus)\n" +
  "===========================================================\n\n" +
  CORPUS;

// ---------------------------------------------------------------------------
// The HTTP server. Every request that arrives is handled by this function.
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    // Health check — handy for confirming the server is alive and configured.
    if (req.method === "GET" && req.url === "/health") {
      return sendJSON(res, 200, {
        ok: true,
        model: MODEL,
        apiKeyConfigured: Boolean(API_KEY),
        accessCodeRequired: Boolean(ACCESS_CODE),
        centralCollection: Boolean(SHEET_WEBHOOK_URL),
        teamCodeRequired: Boolean(TEAM_CODE),
        checkModel: CHECK_MODEL,
        readBack: Boolean(SHEET_WEBHOOK_URL && SHEET_READ_TOKEN),
        photoStorage: R2.configured,
        // Record view (/r/<RecordID>): needs the drafter code AND read-back.
        recordView: Boolean(ACCESS_CODE && SHEET_WEBHOOK_URL && SHEET_READ_TOKEN),
      });
    }

    // Record view page: one observation + its revision history + its photos.
    // The address carries only the Record ID (no secret), so the Google Sheet
    // can build the link with a plain HYPERLINK formula. The page itself asks
    // for the drafter code before it shows anything (see handleRecordView).
    if (req.method === "GET" && RECORD_PAGE_RE.test(req.url.split("?")[0])) {
      return serveRecordPage(res);
    }

    // Record view data: the page calls this with the drafter code.
    if (req.method === "POST" && req.url === "/api/record-view") {
      return await handleRecordView(req, res);
    }

    // The drafting endpoint — the reason the server exists.
    if (req.method === "POST" && req.url === "/api/draft") {
      return await handleDraft(req, res);
    }

    // Observer rules-check: a quick, advisory "what do you think of this?"
    if (req.method === "POST" && req.url === "/api/check") {
      return await handleCheck(req, res);
    }

    // Central collection: forward submitted observations to the Google Sheet.
    if (req.method === "POST" && req.url === "/api/submit") {
      return await handleSubmit(req, res);
    }

    // Drafter read-back: pull the team's observations out of the Sheet.
    if (req.method === "POST" && req.url === "/api/records") {
      return await handleRecords(req, res);
    }

    // Photo upload permission: signs short-lived direct-to-R2 upload links.
    if (req.method === "POST" && req.url === "/api/upload-url") {
      return await handleUploadUrl(req, res);
    }

    // Photo record: verify uploaded photos in R2, then list them on the Media tab.
    if (req.method === "POST" && req.url === "/api/media") {
      return await handleMedia(req, res);
    }

    // Everything else: serve a static file from /public.
    if (req.method === "GET") {
      return serveStatic(req, res);
    }

    sendJSON(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Unhandled error:", err);
    sendJSON(res, 500, { error: "Server error", detail: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Election Complaint Harness is running.`);
  console.log(`  Open:   http://localhost:${PORT}`);
  console.log(`  Model:  ${MODEL}`);
  console.log(`  API key configured: ${API_KEY ? "yes" : "NO — set ANTHROPIC_API_KEY"}`);
  console.log(`  Access code gate:   ${ACCESS_CODE ? "on" : "off"}`);
  console.log(`  Central collection: ${SHEET_WEBHOOK_URL ? "on (Google Sheet)" : "off"}`);
  console.log(`  Drafter read-back:  ${SHEET_WEBHOOK_URL && SHEET_READ_TOKEN ? "on" : "off"}`);
  console.log(`  Rules-check model:  ${CHECK_MODEL}`);
  console.log(`  Team code gate:     ${TEAM_CODE ? "on" : "off"}`);
  console.log(`  Photo storage (R2): ${R2.configured ? "on (bucket " + R2.bucket + ")" : "off"}`);
  console.log(`  Record view (/r/):  ${ACCESS_CODE && SHEET_WEBHOOK_URL && SHEET_READ_TOKEN ? "on" : "off — needs ACCESS_CODE + read-back"}\n`);
});

// ===========================================================================
// Handlers
// ===========================================================================

async function handleDraft(req, res) {
  // 1. Guard the key. If it isn't set, fail loudly and clearly.
  if (!API_KEY) {
    return sendJSON(res, 500, {
      error:
        "The server has no ANTHROPIC_API_KEY set. Add it and restart the server.",
    });
  }

  // 2. Read the JSON the phone sent us.
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJSON(res, 400, { error: "Request body was not valid JSON." });
  }

  // 3. Optional shared-password gate. If you set ACCESS_CODE, the app must
  //    send a matching code or we refuse — this keeps strangers off your key.
  if (ACCESS_CODE && payload.accessCode !== ACCESS_CODE) {
    return sendJSON(res, 401, {
      error: "Wrong or missing access code.",
    });
  }

  // 4. Turn the structured field record into a clean Mode 2 drafting request.
  const userMessage = buildUserMessage(payload);

  // 5. Call the Anthropic API.
  let apiResponse;
  try {
    apiResponse = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
  } catch (err) {
    return sendJSON(res, 502, {
      error: "Could not reach the Anthropic API.",
      detail: String(err),
    });
  }

  // 6. Handle API errors (bad key, wrong model name, rate limit, no credit...).
  if (!apiResponse.ok) {
    const errText = await apiResponse.text();
    console.error("Anthropic API error:", apiResponse.status, errText);
    return sendJSON(res, 502, {
      error: `Anthropic API returned ${apiResponse.status}.`,
      detail: safeTrim(errText, 600),
    });
  }

  // 7. Pull the draft text out of the response — and diagnose HOW it ended.
  const data = await apiResponse.json();
  const blocks = Array.isArray(data.content) ? data.content : [];

  // 7a. Count what KINDS of blocks came back. This is the crucial diagnostic.
  //     `usage.output_tokens` counts EVERY token the model generated, including
  //     any internal "thinking" / "redacted_thinking" blocks — but we only ever
  //     display the "text" blocks. So a model that reasons heavily can report a
  //     huge output_tokens while the visible draft is short, and if that COMBINED
  //     total hits max_tokens the visible draft is cut off mid-word even though
  //     "the draft" looks small. Surfacing the block mix lets us tell that apart
  //     from a genuinely over-long draft. (Observed once: ~8000 output tokens
  //     billed, but only ~1700 tokens of visible text — i.e. ~6300 tokens spent
  //     on something we never showed. That gap is what this exposes.)
  const blockTypes = {};
  for (const b of blocks) blockTypes[b.type] = (blockTypes[b.type] || 0) + 1;
  const hasThinking = blocks.some(
    (b) => b.type === "thinking" || b.type === "redacted_thinking"
  );

  let draft = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // 7b. Did the model FINISH, or hit the output ceiling and stop mid-draft?
  //        "end_turn"   -> finished on its own (good)
  //        "max_tokens" -> hit the max_tokens cap and was cut off
  //     A truncated draft can end mid-word while LOOKING finished on the phone.
  //     For an integrity tool that is the worst failure mode, so we say so
  //     loudly — right at the top of the draft (seen even if the UI ignores the
  //     flag) — and we tailor the reason to whether reasoning ate the budget.
  const stopReason = data.stop_reason || null;
  const truncated = stopReason === "max_tokens";
  if (truncated) {
    const why = hasThinking
      ? "The model spent much of its output budget on internal reasoning\n" +
        "⚠ (thinking) tokens, leaving too little to finish the draft itself.\n" +
        "⚠ Raise DRAFT_MAX_TOKENS well above the reasoning cost, or reduce or\n" +
        "⚠ disable extended thinking for drafting."
      : "The draft reached the output-length limit (max_tokens = " +
        MAX_TOKENS +
        ").\n" +
        "⚠ Raise DRAFT_MAX_TOKENS or split the request into fewer incidents.";
    const banner =
      "⚠ ============================================================\n" +
      "⚠ THIS DRAFT IS INCOMPLETE — IT WAS CUT OFF. DO NOT FILE IT.\n" +
      "⚠ " +
      why +
      "\n" +
      "⚠ The text below may end mid-sentence and is missing its final\n" +
      "⚠ element(s) and the Dismissal Risk Assessment.\n" +
      "⚠ ============================================================\n\n";
    draft = banner + draft;
  }

  return sendJSON(res, 200, {
    draft: draft || "(The model returned no text.)",
    model: MODEL,
    stopReason,   // null on a clean finish, "max_tokens" when cut off
    truncated,    // convenience boolean for the app to branch on
    blockTypes,   // e.g. {"text":1} vs {"thinking":1,"text":1} — the smoking gun
    hasThinking,  // true if the model emitted reasoning blocks we don't display
    usage: data.usage || null, // input_tokens / output_tokens (output INCLUDES thinking)
  });
}

// Convert the app's structured payload into the plain-English request the
// system profile expects for a Mode 2 draft.
function buildUserMessage(p) {
  const filingMode =
    p.filingMode === "attorney" ? "Attorney-filed" : "Observer-filed";

  const lines = [];
  lines.push("MODE 2 — COMPLAINT DRAFTING REQUEST");
  lines.push("");
  lines.push(`Filing mode: ${filingMode}`);
  lines.push("");

  lines.push("== OBSERVER / SOURCE OF RECORD ==");
  const o = p.observer || {};
  lines.push(`Observer name: ${orTBD(o.name)}`);
  lines.push(`Credential / role: ${orTBD(o.credential)}`);
  lines.push(`Organization: ${orTBD(o.organization)}`);
  lines.push(`Standing basis: ${orTBD(o.standing)}`);
  lines.push(`County / jurisdiction: ${orTBD(o.county)}`);
  lines.push(`Observable location type: ${orTBD(o.locationType)}`);
  lines.push("");

  if (p.filingMode === "attorney") {
    lines.push("== FILING ATTORNEY (filer of record) ==");
    const a = p.attorney || {};
    lines.push(`Party / candidate: ${orTBD(a.party)}`);
    lines.push(`Attorney name: ${orTBD(a.name)}`);
    lines.push(`Bar number: ${orTBD(a.bar)}`);
    lines.push(`Contact: ${orTBD(a.contact)}`);
    lines.push("");
  }

  lines.push("== RESPONDENT ==");
  lines.push(orTBD(p.respondent));
  lines.push("");

  lines.push("== RELIEF REQUESTED (observer's preference; refine as needed) ==");
  lines.push(orTBD(p.relief));
  lines.push("");

  lines.push("== FILING TARGET (observer's note; verify) ==");
  lines.push(orTBD(p.filingTarget));
  lines.push("");

  lines.push("== INCIDENT RECORD (first-person field observations) ==");
  const entries = Array.isArray(p.entries) ? p.entries : [];
  if (entries.length === 0) {
    lines.push("(No incident entries were supplied.)");
  }
  entries.forEach((e, i) => {
    const obsType = e.obsType || "anomaly";
    const isAnomaly = obsType === "anomaly";
    const typeLabel =
      obsType === "attestation"
        ? "ATTESTATION — a control point observed being exercised correctly. This is affirmative evidence of integrity, NOT an allegation. Do not draft it as a violation."
        : obsType === "gap"
        ? "COVERAGE GAP — a control point that mattered but could not be observed. This is NOT an allegation of wrongdoing; it records that the moment was unwitnessed. Do not infer a violation from a gap."
        : "ANOMALY — a possible procedural violation to evaluate.";

    lines.push("");
    lines.push(`--- Observation ${i + 1} ---`);
    if (e.observerName) lines.push(`Observed by: ${e.observerName}`);
    lines.push(`Observation type: ${typeLabel}`);
    if (e.controlPoint) lines.push(`Control point: ${e.controlPoint}`);
    lines.push(`Date/time observed: ${orTBD(e.time)}`);
    lines.push(`Location (area / ward): ${orTBD(e.location)}`);
    if (e.station) lines.push(`Station (precise physical position): ${e.station}`);

    // The core narrative field is relabeled by type — the phone captures the
    // same field, but its meaning differs for an attestation vs. a gap.
    const observedLabel = isAnomaly
      ? "What was observed (actions)"
      : obsType === "attestation"
      ? "What confirmed the control was properly exercised"
      : "What control occurred, and why it could not be observed";
    lines.push(`${observedLabel}: ${orTBD(e.observed)}`);

    // Anomaly-only fields. Skipped for attestations/gaps so the drafting model
    // never sees "[NOT PROVIDED]" for a question that doesn't apply to them.
    if (isAnomaly) {
      lines.push(
        `Who performed it (role / name / description / wristband / badge): ${orTBD(
          e.actor
        )}`
      );
    }
    lines.push(`Witnesses present: ${orTBD(e.witnesses)}`);
    if (isAnomaly) {
      lines.push(`On-site objection raised?: ${orTBD(e.objectionRaised)}`);
      lines.push(`Objection statement / to whom / response: ${orTBD(e.objectionDetail)}`);
    }
    lines.push(`Evidence and current custody: ${orTBD(e.evidence)}`);
    if (isAnomaly) {
      lines.push(`Recorded by team on EL 104?: ${orTBD(e.el104)}`);
    }

    // Coverage state travels with every observation type — it is the signal
    // that lets low coverage be correlated later.
    if (e.observersPresent) lines.push(`Observers present at the time: ${e.observersPresent}`);
    if (e.continuouslyObserved) lines.push(`Continuously observed: ${e.continuouslyObserved}`);

    if (isAnomaly && e.issueTags && e.issueTags.length) {
      lines.push(`Issue category tags: ${e.issueTags.join("; ")}`);
    }
    if (isAnomaly && e.suggestedCite) {
      lines.push(`Observer's suggested citation (verify against corpus): ${e.suggestedCite}`);
    }
    if (e.notes) lines.push(`Additional notes: ${e.notes}`);
  });

  lines.push("");
  lines.push("== INSTRUCTIONS ==");
  lines.push(
    "Produce a complete Mode 2 draft per the profile: apply the eight-element anatomy, mark every rule citation with [DIRECT CITATION] / [INFERRED] / [NOT FOUND] against the appended corpus, and append the DISMISSAL RISK ASSESSMENT. " +
      (p.filingMode === "attorney"
        ? "Because this is attorney-filed, lead with the ATTORNEY REVIEW CHECKLIST. "
        : "") +
      "Flag any missing or thin element explicitly rather than inventing facts."
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Observer rules-check. A tightly scoped, advisory-only assistant. It is NOT
// the drafting profile — it flags, it never adjudicates, and it always tells
// the observer to capture facts and log the observation regardless.
// ---------------------------------------------------------------------------
const CHECK_INSTRUCTIONS =
  "You are a field rules-check aid for a credentialed election observer in Wisconsin. " +
  "An observer will briefly describe something they are seeing at an observable location. " +
  "Use ONLY the appended rule corpus (Wis. Admin. Code ch. EL 4 and the observer guidance) as authority. " +
  "Respond in 2–4 short sentences, plain language, for someone standing on the counting floor:\n" +
  "1) Say whether what is described MAY implicate a rule, appears likely to be a violation, or does not appear to implicate ch. EL 4 — and name the specific provision (e.g., EL 4.03(1)(b)) when one applies.\n" +
  "2) Open with a confidence tag in brackets: [LIKELY VIOLATION], [POSSIBLE — VERIFY], or [NOT APPARENT], based only on the corpus.\n" +
  "3) Always tell the observer the specific facts to capture now — exact time, location/table/ward, who by role and description, witnesses — and to log the observation regardless. A drafter, and if needed an attorney, decides later.\n" +
  "Rules of the road: never adjudicate with certainty; never discourage logging; if the corpus does not address the scenario, say so plainly and still advise capturing the facts. Do not draft a complaint. Keep it terse.";

async function handleCheck(req, res) {
  if (!API_KEY) {
    return sendJSON(res, 500, {
      error: "The server has no ANTHROPIC_API_KEY set.",
    });
  }

  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJSON(res, 400, { error: "Request body was not valid JSON." });
  }

  // Team-code gate — keeps this paid endpoint off the open internet.
  if (TEAM_CODE && payload.teamCode !== TEAM_CODE) {
    return sendJSON(res, 401, {
      error: "Wrong or missing team code. Enter it under Setup.",
    });
  }

  const text = (payload.text || "").toString().trim();
  if (!text) {
    return sendJSON(res, 400, { error: "Describe what you're seeing first." });
  }

  let apiResponse;
  try {
    apiResponse = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: CHECK_MODEL,
        max_tokens: 500,
        // Corpus is marked for prompt caching so repeated checks are cheap.
        system: [
          { type: "text", text: CHECK_INSTRUCTIONS },
          {
            type: "text",
            text:
              "APPENDED SOURCE OF TRUTH — the loaded rule corpus:\n\n" + CORPUS,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: "Observer is seeing this right now:\n\n" + text,
          },
        ],
      }),
    });
  } catch (err) {
    return sendJSON(res, 502, {
      error: "Could not reach the Anthropic API.",
      detail: String(err),
    });
  }

  if (!apiResponse.ok) {
    const errText = await apiResponse.text();
    return sendJSON(res, 502, {
      error: `Anthropic API returned ${apiResponse.status}.`,
      detail: safeTrim(errText, 500),
    });
  }

  const data = await apiResponse.json();
  const assessment = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return sendJSON(res, 200, {
    assessment: assessment || "(No response.)",
    model: CHECK_MODEL,
    usage: data.usage || null,
  });
}

// The columns written to the Google Sheet, in order. The Apps Script writes
// this as the header row the first time, then one row per observation.
const SUBMIT_COLUMNS = [
  "Record ID",
  "Revision",
  "Status",
  "Submitted (server time)",
  "Observer",
  "Organization",
  "County",
  "Time observed",
  "Location",
  "What observed",
  "Who (role/name/description)",
  "Witnesses",
  "Objection raised",
  "Objection detail",
  "Evidence & custody",
  "EL 104?",
  "Issue tags",
  "Suggested citation",
  "Notes",
  // ---- Signal-capture schema v2 (appended at the END so historical rows stay
  //      column-aligned; never insert mid-order). obsType is the three-state
  //      field — attestation / anomaly / gap — that makes a clean watch and a
  //      blind spot first-class facts, not just violations.
  "Obs type",
  "Control point",
  "Station",
  "Observers present",
  "Continuously observed",
];

// Receives {observer, entries:[...]} from an observer's phone and forwards it,
// row by row, to your Google Sheet via the Apps Script web app.
async function handleSubmit(req, res) {
  if (!SHEET_WEBHOOK_URL) {
    return sendJSON(res, 501, {
      error:
        "Central collection isn't set up yet. The server has no SHEET_WEBHOOK_URL. See the README, 'Central collection'.",
    });
  }

  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJSON(res, 400, { error: "Request body was not valid JSON." });
  }

  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (entries.length === 0) {
    return sendJSON(res, 400, { error: "No observations to submit." });
  }

  const o = payload.observer || {};
  const stamp = new Date().toISOString();
  const rows = entries.map((e) => {
    const rev = Number(e.rev) || 1;
    const status = rev > 1 ? `Edit — supersedes v${rev - 1}` : "Original";
    return [
    e.id || "",
    `v${rev}`,
    status,
    stamp,
    o.name || "",
    o.organization || "",
    o.county || "",
    e.time || "",
    e.location || "",
    e.observed || "",
    e.actor || "",
    e.witnesses || "",
    e.objectionRaised || "",
    e.objectionDetail || "",
    e.evidence || "",
    e.el104 || "",
    Array.isArray(e.issueTags) ? e.issueTags.join("; ") : "",
    e.suggestedCite || "",
    e.notes || "",
    // ---- Signal-capture schema v2 (must stay in the same order as the tail
    //      of SUBMIT_COLUMNS). Default obsType to "anomaly" so any legacy
    //      client that doesn't send it still lands in a valid state.
    e.obsType || "anomaly",
    e.controlPoint || "",
    e.station || "",
    e.observersPresent || "",
    e.continuouslyObserved || "",
    ];
  });

  let r;
  try {
    r = await fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ header: SUBMIT_COLUMNS, rows }),
    });
  } catch (err) {
    return sendJSON(res, 502, {
      error: "Could not reach the Google Sheet web app.",
      detail: String(err),
    });
  }

  if (!r.ok) {
    const t = await r.text();
    return sendJSON(res, 502, {
      error: `The Google Sheet web app returned ${r.status}.`,
      detail: safeTrim(t, 400),
    });
  }

  // Reply verification. An HTTP 200 alone does NOT prove the rows were written:
  // Apps Script answers 200 even when it REFUSES (e.g. the header schema guard),
  // and a Google login/redirect page can also come back as 200. Only an explicit
  // {"ok": true} from our script counts as success. Anything else is a failure,
  // so the phone keeps the observations queued instead of marking them "sent".
  const replyText = await r.text();
  let reply = null;
  try {
    reply = JSON.parse(replyText);
  } catch {
    /* not JSON — handled below */
  }
  if (!reply || reply.ok !== true) {
    return sendJSON(res, 502, {
      error: reply && reply.error
        ? "The Google Sheet refused the write: " + reply.error
        : "The Google Sheet web app did not confirm the write (unexpected reply). Nothing was marked sent.",
      detail: reply ? undefined : safeTrim(replyText, 300),
    });
  }

  return sendJSON(res, 200, { ok: true, submitted: rows.length });
}

// Drafter read-back: fetch the sheet via the Apps Script (token-protected),
// collapse to the latest revision per Record ID, return a clean list.
async function handleRecords(req, res) {
  if (!SHEET_WEBHOOK_URL || !SHEET_READ_TOKEN) {
    return sendJSON(res, 501, {
      error:
        "Drafter read-back isn't set up. The server needs SHEET_WEBHOOK_URL and SHEET_READ_TOKEN, and the Apps Script needs a matching READ_TOKEN.",
    });
  }

  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJSON(res, 400, { error: "Request body was not valid JSON." });
  }

  // Reading the whole repo is a drafter action — gate it with the drafter code.
  if (ACCESS_CODE && payload.accessCode !== ACCESS_CODE) {
    return sendJSON(res, 401, { error: "Wrong or missing drafter code." });
  }

  const url =
    SHEET_WEBHOOK_URL +
    (SHEET_WEBHOOK_URL.includes("?") ? "&" : "?") +
    "action=records&token=" +
    encodeURIComponent(SHEET_READ_TOKEN);

  let r;
  try {
    r = await fetch(url, { method: "GET" });
  } catch (err) {
    return sendJSON(res, 502, {
      error: "Could not reach the Google Sheet web app.",
      detail: String(err),
    });
  }
  if (!r.ok) {
    const t = await r.text();
    return sendJSON(res, 502, {
      error: `The Google Sheet web app returned ${r.status}.`,
      detail: safeTrim(t, 300),
    });
  }

  let data;
  try {
    data = await r.json();
  } catch {
    return sendJSON(res, 502, {
      error:
        "The Sheet web app did not return JSON — check that the deployment is current and Web app access is 'Anyone'.",
    });
  }
  if (!data.ok) {
    return sendJSON(res, 502, {
      error:
        "Sheet read failed (" +
        (data.error || "unknown") +
        "). Check that READ_TOKEN in the Apps Script matches SHEET_READ_TOKEN.",
    });
  }

  const latest = collapseLatest(data.records || []);
  return sendJSON(res, 200, { ok: true, count: latest.length, records: latest });
}

// Group raw sheet rows by Record ID, keep the highest revision, map to the
// shape the drafting UI uses.
function collapseLatest(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = row["Record ID"] || "";
    if (!id) continue;
    const rev =
      parseInt(String(row["Revision"] || "v1").replace(/[^0-9]/g, ""), 10) || 1;
    const prev = byId.get(id);
    if (!prev || rev > prev._rev) byId.set(id, { _rev: rev, row });
  }
  return [...byId.values()].map(({ _rev, row }) => ({
    id: row["Record ID"] || "",
    rev: _rev,
    status: row["Status"] || "",
    observer: row["Observer"] || "",
    time: row["Time observed"] || "",
    location: row["Location"] || "",
    observed: row["What observed"] || "",
    actor: row["Who (role/name/description)"] || "",
    witnesses: row["Witnesses"] || "",
    objectionRaised: row["Objection raised"] || "",
    objectionDetail: row["Objection detail"] || "",
    evidence: row["Evidence & custody"] || "",
    el104: row["EL 104?"] || "",
    issueTags: String(row["Issue tags"] || "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    suggestedCite: row["Suggested citation"] || "",
    notes: row["Notes"] || "",
    // Signal-capture schema v2. Older sheet rows won't have these headers, so
    // default obsType to "anomaly" and the rest to blank.
    obsType: row["Obs type"] || "anomaly",
    controlPoint: row["Control point"] || "",
    station: row["Station"] || "",
    observersPresent: row["Observers present"] || "",
    continuouslyObserved: row["Continuously observed"] || "",
  }));
}

// ===========================================================================
// Photo storage — signed direct-to-R2 uploads
// ---------------------------------------------------------------------------
// Photos NEVER pass through this server. The phone asks here for permission;
// we answer with a "presigned URL" — a normal web address with a signature
// made from our R2 secret, valid for one file, one path, 10 minutes. The phone
// then sends the photo straight to Cloudflare R2 with that URL. This keeps big
// files off our small server and keeps the R2 secret off the phones.
//
// The signing recipe is Amazon's "Signature Version 4" (R2 speaks the S3
// protocol), verified against Amazon's published reference example. A
// standalone copy lives in tools/r2-presign.js for the smoke test — if you
// change the signer here, change it there too. One wrong byte = every upload 403s.
// ===========================================================================

async function handleUploadUrl(req, res) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJSON(res, 400, { error: "Request body was not valid JSON." });
  }

  // Same team-code gate as the rules-check. An ungated upload endpoint is an
  // open file host, so unlike /api/submit this one is NOT harmless when open.
  if (TEAM_CODE && payload.teamCode !== TEAM_CODE) {
    return sendJSON(res, 401, {
      error: "Wrong or missing team code. Enter it under Setup.",
    });
  }

  const out = buildUploadUrls(payload, R2);
  return sendJSON(res, out.status, out.json);
}

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


// ===========================================================================
// Photo record — /api/media
// ---------------------------------------------------------------------------
// The phone calls this AFTER its photos are in R2. For each photo we:
//   1. check the storage key is exactly records/<RecordID>/<sha256>.<ext>
//      (so a request can't point at some other file);
//   2. download it from R2 and RECOMPUTE its SHA-256 here on the server,
//      checking it against the fingerprint the phone computed at capture and
//      the size it reported. The Media row then records that the fingerprint
//      was independently confirmed — not just reported by the phone;
//   3. only then send the row to the Sheet's Media tab.
// A photo that fails a check is NOT recorded; the phone is told why, keeps its
// copy, and re-uploads it.
// ===========================================================================

const MEDIA_COLUMNS = [
  "Record ID",
  "Record revision at attach",
  "Photo SHA-256",
  "Fingerprint check",
  "Storage key",
  "Size (bytes)",
  "Type",
  "Added on phone",
  "File timestamp (phone)",
  "Uploaded",
  "Recorded (server time)",
  "Observer",
  "Organization",
  "Location",
  "Latitude",
  "Longitude",
  "Location accuracy (m)",
];
const MEDIA_MAX_PER_CALL = 10;
const MEDIA_MAX_BYTES = 50 * 1024 * 1024; // refuse to hash anything absurd

async function handleMedia(req, res) {
  if (!R2.configured) {
    return sendJSON(res, 503, { error: "Photo storage is not configured on the server (R2_* env vars)." });
  }
  if (!SHEET_WEBHOOK_URL) {
    return sendJSON(res, 501, { error: "Central collection isn't set up (no SHEET_WEBHOOK_URL)." });
  }
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJSON(res, 400, { error: "Request body was not valid JSON." });
  }
  if (TEAM_CODE && payload.teamCode !== TEAM_CODE) {
    return sendJSON(res, 401, { error: "Wrong or missing team code. Enter it under Setup." });
  }
  const photos = Array.isArray(payload.photos) ? payload.photos : [];
  if (!photos.length) return sendJSON(res, 400, { error: "No photos listed." });
  if (photos.length > MEDIA_MAX_PER_CALL) {
    return sendJSON(res, 400, { error: `Too many photos in one request (max ${MEDIA_MAX_PER_CALL}).` });
  }

  const o = payload.observer || {};
  const stamp = new Date().toISOString();
  const rows = [];
  const rejected = [];

  for (const p of photos) {
    const recordId = String(p.recordId || "");
    const sha = String(p.sha256 || "").toLowerCase();
    const ext = ALLOWED_TYPES[p.contentType];
    const key = String(p.key || "");
    if (!RECORD_ID_RE.test(recordId) || !SHA256_RE.test(sha) || !ext ||
        key !== `records/${recordId}/${sha}.${ext}`) {
      rejected.push({ key, reason: "Storage key doesn't match the photo's Record ID and fingerprint." });
      continue;
    }

    const check = await verifyStoredPhoto(key, sha, Number(p.size));
    if (!check.ok) {
      rejected.push({ key, reason: check.reason });
      continue;
    }

    const loc = p.location || {};
    rows.push([
      recordId,
      `v${Number(p.recordRev) || 1}`,
      sha,
      "Confirmed — server recomputed SHA-256 from the stored file",
      key,
      check.size,
      p.contentType,
      p.addedAt || "",
      p.fileModified || "",
      p.uploadedAt || "",
      stamp,
      o.name || p.observer || "",
      o.organization || "",
      loc.status || "unknown",
      loc.status === "ok" ? loc.lat : "",
      loc.status === "ok" ? loc.lon : "",
      loc.status === "ok" ? loc.accuracyM : "",
    ]);
  }

  if (!rows.length) {
    return sendJSON(res, 200, { ok: true, recorded: [], rejected });
  }

  // Send to the Sheet and insist on an explicit {"ok": true} — same reply
  // verification as /api/submit.
  let r;
  try {
    r = await fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "media", header: MEDIA_COLUMNS, rows }),
    });
  } catch (err) {
    return sendJSON(res, 502, { error: "Could not reach the Google Sheet web app.", detail: String(err) });
  }
  const replyText = await r.text();
  let reply = null;
  try { reply = JSON.parse(replyText); } catch { /* handled below */ }
  if (!r.ok || !reply || reply.ok !== true) {
    return sendJSON(res, 502, {
      error: reply && reply.error
        ? "The Google Sheet refused the photo records: " + reply.error
        : "The Google Sheet web app did not confirm the photo records. Nothing was marked sent.",
      detail: reply ? undefined : safeTrim(replyText, 300),
    });
  }
  // An Apps Script without the Media branch would answer {"ok":true} from the
  // OLD code path (writing photo rows into the main sheet!). Its reply has no
  // `recorded` list — treat that as a failure, loudly.
  if (!Array.isArray(reply.recorded)) {
    return sendJSON(res, 502, {
      error: "The Google Sheet script is out of date (no Media tab support). Deploy the new google-apps-script.gs as a New version.",
    });
  }
  return sendJSON(res, 200, { ok: true, recorded: reply.recorded, rejected });
}

// Download one photo from R2 and recompute its fingerprint as it streams in.
async function verifyStoredPhoto(key, expectedSha, expectedSize) {
  let r;
  try {
    r = await fetch(r2Url(R2, "GET", key, 300));
  } catch (err) {
    return { ok: false, reason: "Couldn't reach photo storage to verify (" + String(err) + ")." };
  }
  if (r.status === 404) return { ok: false, reason: "Photo not found in storage — it will be re-uploaded." };
  if (!r.ok) return { ok: false, reason: `Photo storage answered ${r.status} when verifying.` };

  const hash = crypto.createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > MEDIA_MAX_BYTES) return { ok: false, reason: "Photo is larger than the 50 MB limit." };
      hash.update(chunk);
    }
  } catch (err) {
    return { ok: false, reason: "Download interrupted while verifying (" + String(err) + ")." };
  }
  const actual = hash.digest("hex");
  if (actual !== expectedSha) {
    return { ok: false, reason: "Stored file's fingerprint does NOT match the phone's — not recorded; it will be re-uploaded." };
  }
  if (Number.isFinite(expectedSize) && expectedSize > 0 && expectedSize !== size) {
    return { ok: false, reason: "Stored file's size doesn't match what the phone reported." };
  }
  return { ok: true, size };
}

// ===========================================================================
// Record view — /r/<RecordID> page + /api/record-view data
// ---------------------------------------------------------------------------
// Lets principals see one observation, every revision of it, and every photo
// attached to it, on one page. The link in the Sheet is just
//   https://<site>/r/<RecordID>
// which carries no secret; the page asks for the drafter code (ACCESS_CODE)
// and sends it here. We then:
//   1. read that record's rows from the main sheet and its photo rows from the
//      Media tab (both through the Apps Script, with SHEET_READ_TOKEN);
//   2. for each photo the Media tab lists — i.e. each photo whose fingerprint
//      the server already confirmed — sign a short-lived VIEW link to R2.
// The bucket stays private: a viewing link dies after VIEW_TTL_SECONDS, so a
// forwarded link stops working. Photos are listed from the Media tab, not by
// browsing the bucket, so an upload that never passed verification is never
// shown as if it were part of the record.
//
// This FAILS CLOSED: if ACCESS_CODE isn't set on the server, the page refuses
// to show anything (unlike the older drafter endpoints, which run open when no
// code is set). Photos are evidence; "no code configured" must not mean
// "anyone with a Record ID can look".
// ===========================================================================

const RECORD_PAGE_RE = /^\/r\/[A-Za-z0-9-]{8,64}\/?$/;
const VIEW_TTL_SECONDS = 900; // 15 minutes
const PHOTO_KEY_RE = /^records\/([A-Za-z0-9-]{8,64})\/([a-f0-9]{64})\.(jpg|png|heic|heif|webp)$/;

function serveRecordPage(res) {
  fs.readFile(path.join(__dirname, "public", "record.html"), (err, content) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Record page missing (public/record.html).");
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      // Don't leak the Record ID (or signed photo links) to other sites when a
      // viewer clicks out, e.g. to a map. Keep the page out of search engines.
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    });
    res.end(content);
  });
}

async function handleRecordView(req, res) {
  if (!ACCESS_CODE) {
    return sendJSON(res, 503, {
      error: "Record view is off: the server has no drafter code (ACCESS_CODE) set, and this page refuses to run without one.",
    });
  }
  if (!SHEET_WEBHOOK_URL || !SHEET_READ_TOKEN) {
    return sendJSON(res, 501, {
      error: "Record view needs read-back: SHEET_WEBHOOK_URL and SHEET_READ_TOKEN on the server, and a matching READ_TOKEN in the Apps Script.",
    });
  }

  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJSON(res, 400, { error: "Request body was not valid JSON." });
  }
  if (payload.accessCode !== ACCESS_CODE) {
    return sendJSON(res, 401, { error: "Wrong or missing drafter code." });
  }
  const recordId = String(payload.recordId || "");
  if (!RECORD_ID_RE.test(recordId)) {
    return sendJSON(res, 400, { error: "That isn't a valid Record ID." });
  }

  // Both reads go out at once; each comes back {data} or {error}.
  const [rec, med] = await Promise.all([
    sheetRead("records", recordId),
    sheetRead("media", recordId),
  ]);
  if (rec.error) return sendJSON(res, 502, { error: rec.error });
  if (med.error) return sendJSON(res, 502, { error: med.error });

  // The script MUST answer the media read with a `media` list. An older script
  // has no media branch and falls through to its liveness reply ({ok:true,
  // service:...}) — which would look like "no photos". Say so loudly instead.
  if (!Array.isArray(med.data.media)) {
    return sendJSON(res, 502, {
      error: "The Google Sheet script is out of date (it can't read the Media tab). Paste the new google-apps-script.gs and deploy it as a New version.",
    });
  }

  // Filter here too, even though the new script filters: an older script
  // ignores the `record` parameter and returns every row.
  const revisions = (rec.data.records || [])
    .filter((r) => String(r["Record ID"] || "") === recordId)
    .map((row) => ({ rev: revNumber(row["Revision"]), row }))
    .sort((a, b) => a.rev - b.rev)
    .map((x) => x.row);

  const photos = med.data.media
    .filter((m) => String(m["Record ID"] || "") === recordId)
    .map((m) => {
      const key = String(m["Storage key"] || "");
      const k = key.match(PHOTO_KEY_RE);
      const sha = String(m["Photo SHA-256"] || "").toLowerCase();
      // Only sign a link if the key is exactly records/<this ID>/<this sha>.<ext>.
      // A row that doesn't line up is still shown — flagged, with no link.
      const consistent = Boolean(k && k[1] === recordId && k[2] === sha);
      return {
        row: m,
        url: consistent && R2.configured ? r2Url(R2, "GET", key, VIEW_TTL_SECONDS) : null,
        problem: !consistent
          ? "This photo's storage key doesn't match its Record ID and fingerprint, so no link was made. Check the Media tab."
          : !R2.configured
          ? "Photo storage isn't configured on the server, so no link was made."
          : null,
      };
    });

  if (!revisions.length && !photos.length) {
    return sendJSON(res, 404, { error: "No observation or photos with that Record ID." });
  }

  return sendJSON(res, 200, {
    ok: true,
    recordId,
    revisions,
    photos,
    linkMinutes: VIEW_TTL_SECONDS / 60,
    generatedAt: new Date().toISOString(),
  });
}

// One token-protected GET to the Apps Script. Returns {data} or {error}.
async function sheetRead(action, recordId) {
  const url =
    SHEET_WEBHOOK_URL +
    (SHEET_WEBHOOK_URL.includes("?") ? "&" : "?") +
    "action=" + action +
    "&token=" + encodeURIComponent(SHEET_READ_TOKEN) +
    "&record=" + encodeURIComponent(recordId);
  let r;
  try {
    r = await fetch(url, { method: "GET" });
  } catch (err) {
    return { error: "Could not reach the Google Sheet web app (" + String(err) + ")." };
  }
  if (!r.ok) return { error: `The Google Sheet web app returned ${r.status}.` };
  let data;
  try {
    data = await r.json();
  } catch {
    return { error: "The Sheet web app did not return JSON — check that the deployment is current and Web app access is 'Anyone'." };
  }
  if (!data.ok) {
    return {
      error: "Sheet read failed (" + (data.error || "unknown") + "). Check that READ_TOKEN in the Apps Script matches SHEET_READ_TOKEN.",
    };
  }
  return { data };
}

function revNumber(v) {
  return parseInt(String(v || "v1").replace(/[^0-9]/g, ""), 10) || 1;
}

// ===========================================================================
// Small helpers
// ===========================================================================

function serveStatic(req, res) {
  // Map "/" to index.html; strip query strings; block path traversal.
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(__dirname, "public", path.normalize(urlPath));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    return sendJSON(res, 403, { error: "Forbidden" });
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    const headers = { "content-type": contentType(filePath) };
    // HTML must be re-checked on every visit, or phones keep running an old
    // cached copy of the app after a deploy. ("no-cache" doesn't mean "never
    // store" — it means "ask the server whether it changed before using it".)
    if (filePath.endsWith(".html")) headers["cache-control"] = "no-cache";
    res.writeHead(200, headers);
    res.end(content);
  });
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        // ~2MB cap; reject absurdly large bodies.
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (err) {
    console.error(`Could not read ${p}:`, err.message);
    return "";
  }
}

function orTBD(v) {
  const s = (v == null ? "" : String(v)).trim();
  return s.length ? s : "[NOT PROVIDED]";
}

function safeTrim(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// A tiny .env loader so you don't need any extra package. It reads a file
// named ".env" in this folder and copies KEY=value lines into the environment.
function loadDotEnvIfPresent() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // strip surrounding quotes if present
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (err) {
    console.error("Could not load .env:", err.message);
  }
}
