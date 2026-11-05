/* ===========================================================================
 * google-apps-script.gs  —  the bridge between the app and your Google Sheet
 * ---------------------------------------------------------------------------
 * You do NOT run this on your computer or on Render. You paste it into Google's
 * Apps Script editor, attached to a Google Sheet you create. It does two jobs:
 *
 *   WRITE (doPost): observers' "Submit to team" appends rows to the sheet.
 *                   Photo records ({kind:"media"}) go to a separate "Media"
 *                   tab instead — the main sheet's columns never change.
 *   READ  (doGet):  drafters' "Load from team repo" and the record-view page
 *                   (/r/<RecordID>) pull rows back out — observations and
 *                   Media-tab photo rows — but ONLY when a matching secret
 *                   token is supplied, so the data isn't readable by anyone
 *                   who finds the URL.
 *
 * SETUP (full steps in the README, "Central collection" and "Drafter read-back"):
 *   1. Create a Google Sheet.
 *   2. Extensions -> Apps Script.
 *   3. Delete the sample code, paste THIS in.
 *   4. Set READ_TOKEN below to a secret of your choice (any random string).
 *      Put the SAME value in Render as the env var SHEET_READ_TOKEN.
 *   5. Save.
 *   6. Deploy -> New deployment (or Manage deployments -> New version) ->
 *      Web app, Execute as: Me, Who has access: Anyone.
 *   7. Copy the /exec URL into Render as SHEET_WEBHOOK_URL (if not already set).
 * ========================================================================= */

// >>> To turn read-back ON: put a long random secret here (in the Apps Script
//     editor ONLY — never in GitHub) and the SAME value in Render as
//     SHEET_READ_TOKEN. Empty = read-back locked shut (every read refused).
var READ_TOKEN = "";

// Name of the tab that holds one row per photo. Created automatically.
var MEDIA_TAB = "Media";

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Photo records go to their own tab (see writeMedia below).
    if (data.kind === "media") return writeMedia(data);

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    if (sheet.getLastRow() === 0 && data.header) {
      // Empty sheet: write the header row once.
      sheet.appendRow(data.header);
    } else if (data.header) {
      // Schema guard. The sheet already has a header, so it must match the one
      // the server is sending. A mismatch means the column schema changed (for
      // example, the signal-capture v2 columns were appended) but this sheet
      // still carries the OLD header — appending 24-column rows under a
      // 19-column header would silently misalign every new row and quietly
      // corrupt the record. Refuse loudly instead, and tell the operator to
      // rotate the sheet. (This is the append-only integrity rule applied to
      // the schema itself: never let the record be silently changed.)
      var existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (!headersMatch(existing, data.header)) {
        return json({
          ok: false,
          error:
            "schema mismatch: this sheet's header has " + existing.length +
            " columns but the server sent " + data.header.length +
            ". Archive the current data to a new tab, clear the FIRST sheet so " +
            "the new header can be written, then resubmit. (Signal-capture v2 " +
            "adds 5 columns: 19 -> 24.)"
        });
      }
    }

    // Append one row per observation.
    var rows = data.rows || [];
    for (var i = 0; i < rows.length; i++) {
      sheet.appendRow(rows[i]);
    }

    return json({ ok: true, added: rows.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};

  // Read-back mode: return rows as JSON, but only with the right token.
  //   action=records -> the main (first) sheet: observations
  //   action=media   -> the Media tab: one row per verified photo
  // Optional &record=<Record ID> returns only that record's rows (used by the
  // record-view page so it doesn't pull the whole sheet).
  if (params.action === "records" || params.action === "media") {
    if (!READ_TOKEN || params.token !== READ_TOKEN) {
      return json({ ok: false, error: "unauthorized" });
    }
    var only = params.record ? String(params.record) : "";
    if (params.action === "records") {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
      return json({ ok: true, records: rowsAsObjects(sheet, only) });
    }
    var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEDIA_TAB);
    return json({ ok: true, media: tab ? rowsAsObjects(tab, only) : [] });
  }

  // Default: a simple liveness check you can open in a browser.
  return json({ ok: true, service: "observer-central-collection" });
}

// Turn a tab into [{Header: value, ...}, ...] using its first row as the keys.
// If `only` is given, keep just the rows whose "Record ID" equals it.
function rowsAsObjects(sheet, only) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0];
  var idCol = header.indexOf("Record ID");
  var out = [];
  for (var r = 1; r < values.length; r++) {
    if (only && idCol >= 0 && String(values[r][idCol]) !== only) continue;
    var obj = {};
    for (var c = 0; c < header.length; c++) {
      obj[header[c]] = values[r][c];
    }
    out.push(obj);
  }
  return out;
}

// True only if two header rows have the same length and the same trimmed cell
// values in the same order. Used by the doPost schema guard above.
function headersMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (String(a[i]).trim() !== String(b[i]).trim()) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// MEDIA tab: one row per photo, linked to its observation by Record ID.
// Same rules as the main sheet: header written once, schema guard on every
// write, append-only. One extra rule: a photo already listed (same storage
// key) is not listed twice — so a phone retrying after a lost reply can't
// create duplicate rows. Returns which keys are now on the tab.
// ---------------------------------------------------------------------------
function writeMedia(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName(MEDIA_TAB);
  if (!tab) tab = ss.insertSheet(MEDIA_TAB, ss.getSheets().length); // add at the END, never first

  var header = data.header || [];
  if (tab.getLastRow() === 0) {
    tab.appendRow(header);
  } else {
    var existing = tab.getRange(1, 1, 1, tab.getLastColumn()).getValues()[0];
    if (!headersMatch(existing, header)) {
      return json({
        ok: false,
        error:
          "schema mismatch on the " + MEDIA_TAB + " tab: it has " + existing.length +
          " columns but the server sent " + header.length +
          ". Rename the tab (e.g. '" + MEDIA_TAB + " (old)') so a fresh one is created, then resubmit."
      });
    }
  }

  var keyCol = header.indexOf("Storage key");
  var seen = {};
  if (keyCol >= 0 && tab.getLastRow() > 1) {
    var keys = tab.getRange(2, keyCol + 1, tab.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) seen[String(keys[i][0])] = true;
  }

  var recorded = [];
  var rows = data.rows || [];
  for (var r = 0; r < rows.length; r++) {
    var key = keyCol >= 0 ? String(rows[r][keyCol]) : "";
    if (!(key && seen[key])) {
      tab.appendRow(rows[r]);
      seen[key] = true;
    }
    if (key) recorded.push(key);   // listed now, whether just added or already there
  }
  return json({ ok: true, recorded: recorded });
}

function json(o) {
  return ContentService
    .createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
