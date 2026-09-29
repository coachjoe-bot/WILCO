// ─── AUDIT: manual_one_rms rows already corrupted by the pre-fix unit default ──
// DRY RUN ONLY. Never writes, never repairs. The bug (T64 S7 / commit 198cd9a):
// pr_attempts carried no unit, and the writer defaulted a missing unit to "lbs".
// A kg athlete's "hit a 102kg snatch, new PR" stored weight:102, unit:"lbs" in
// manual_one_rms — the RAW number survives untouched (units.js storage contract),
// only the unit label is wrong. So the signature of a corrupted row is: a
// unit:"lbs", source:"workout" manual_one_rms row whose weight number is the exact
// number (allowing for rounding) written next to "kg"/"kilos" in that same
// athlete's workouts.raw_message within a day of the row.
//
// Scope, per the fix: only source:"workout" rows can carry this defect — the
// Settings "edit your max" flow (source:"manual") tags whatever the ATHLETE'S
// DISPLAY UNIT was at the moment they typed it, a different and unaffected code
// path (src/App.jsx saveManual). A source:"manual" row that happens to coincide in
// time and number with a kg-worded chat message is very likely the athlete having
// manually entered a self-converted number, not this bug — printed separately,
// below the confirmed candidates, for a human to judge.
//
// Candidate athletes: weight_unit = 'kg', OR any athlete who has EVER written "kg"
// in a workouts.raw_message (an lbs-display athlete can still state one lift's PR
// in kg). The known QA fixture id is excluded (not a real athlete).
//
//   node --env-file=.env scripts/audit-pr-attempt-units.mjs          # table
//   node --env-file=.env scripts/audit-pr-attempt-units.mjs --json   # machine output
//
import { writtenUnit } from "../src/prAttempts.js";

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY"); process.exit(1); }
if (process.argv.includes("--apply") || process.argv.includes("--fix") || process.argv.includes("--repair")) {
  console.error("This audit is dry-run only. It never writes or repairs a row.");
  process.exit(2);
}
const QA_ATHLETE_ID = "99999999-9999-4999-8999-999999999999"; // fixture, not a real athlete

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sb = async (path) => {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const sbAll = async (pathBase, extra = "") => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await sb(`${pathBase}&offset=${from}&limit=1000${extra}`);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const round1 = (n) => Math.round(n * 10) / 10;

// ── candidate athletes ────────────────────────────────────────────────────────
const kgAthletes = await sbAll("athletes?weight_unit=eq.kg&select=id,name,weight_unit");
const kgMsgRows = await sbAll("workouts?raw_message=ilike.*kg*&select=athlete_id");
const kgMentionIds = new Set(kgMsgRows.map((r) => r.athlete_id));
const candidateIds = new Set([...kgAthletes.map((a) => a.id), ...kgMentionIds]);
candidateIds.delete(QA_ATHLETE_ID);
const weightUnitById = new Map(kgAthletes.map((a) => [a.id, a.weight_unit]));

// ── suspect manual_one_rms rows: unit lbs, written by the automated path ───────
const lbsRows = await sbAll(
  "manual_one_rms?unit=eq.lbs&source=eq.workout&select=id,athlete_id,exercise,normalized_exercise,weight,unit,source,created_at,updated_at"
).then((rows) => rows.filter((r) => candidateIds.has(r.athlete_id)));

const confirmed = [];
const uncertain = []; // source:"manual" rows, printed separately, same numeric/time signature

// A "manual" row can still coincide by pure number/athlete self-entry; check those
// too so a human can eyeball them, but they never count as a confirmed hit.
const manualRows = await sbAll(
  "manual_one_rms?unit=eq.lbs&source=eq.manual&select=id,athlete_id,exercise,normalized_exercise,weight,unit,source,created_at,updated_at"
).then((rows) => rows.filter((r) => candidateIds.has(r.athlete_id)));

const athleteMsgCache = new Map();
const messagesFor = async (athleteId) => {
  if (athleteMsgCache.has(athleteId)) return athleteMsgCache.get(athleteId);
  const rows = await sb(`workouts?athlete_id=eq.${athleteId}&raw_message=ilike.*kg*&select=id,raw_message,created_at&order=created_at.asc`);
  athleteMsgCache.set(athleteId, rows);
  return rows;
};

const checkRow = async (row) => {
  const msgs = await messagesFor(row.athlete_id);
  const rowTimes = [new Date(row.created_at).getTime(), new Date(row.updated_at || row.created_at).getTime()];
  for (const m of msgs) {
    const t = new Date(m.created_at).getTime();
    if (!rowTimes.some((rt) => Math.abs(rt - t) <= DAY_MS)) continue;
    if (writtenUnit(m.raw_message, row.weight) === "kg") {
      return { row, message: m };
    }
  }
  return null;
};

for (const row of lbsRows) {
  const hit = await checkRow(row);
  if (hit) confirmed.push(hit);
}
for (const row of manualRows) {
  const hit = await checkRow(row);
  if (hit) uncertain.push(hit);
}

const excerpt = (text, num) => {
  const i = String(text).indexOf(String(num));
  if (i < 0) return String(text).replace(/\s+/g, " ").slice(0, 160);
  const s = Math.max(0, i - 40), e = Math.min(text.length, i + String(num).length + 20);
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ")}${e < text.length ? "…" : ""}`;
};

const printRow = (h) => {
  const { row, message } = h;
  console.log(
    `athlete ${row.athlete_id.slice(0, 8)}  ${(row.exercise || row.normalized_exercise || "?").padEnd(22)} ` +
    `stored ${row.weight} lbs (source:${row.source})  row_at ${String(row.created_at).slice(0, 10)}\n` +
    `    message (${String(message.created_at).slice(0, 16)}): "${excerpt(message.raw_message, row.weight)}"\n` +
    `    corrected pair: ${row.weight} kg  (row id ${row.id})`
  );
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ confirmed, uncertain }, null, 2));
} else {
  console.log(`Candidate athletes (kg setting or ever wrote "kg"): ${candidateIds.size}`);
  console.log(`manual_one_rms unit:lbs source:workout rows scanned: ${lbsRows.length}`);
  console.log(`manual_one_rms unit:lbs source:manual rows scanned (for reference only): ${manualRows.length}\n`);

  console.log(`── CONFIRMED (source:"workout" — this bug's own write path): ${confirmed.length} ──`);
  confirmed.forEach(printRow);

  console.log(`\n── FOR REVIEW (source:"manual" — the Settings edit tags the display unit at entry time; a` +
    ` coincidence in number/timing with a kg-worded message may just be the athlete's own manual conversion, not this bug): ${uncertain.length} ──`);
  uncertain.forEach(printRow);

  if (!confirmed.length && !uncertain.length) console.log("(none found)");
}
