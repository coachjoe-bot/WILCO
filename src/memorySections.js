// ─── MEMORY SECTIONS (T69-C) ─────────────────────────────────────────────────
// Will 10-01/10-02: the Athlete Context tab has six sections, in this order:
// Bio, Goal, Schedule, Body, Preferences, This week. Bio is the profile and the
// goal is athlete_goals, so a stored NOTE lives in one of four: schedule, body,
// preferences, this_week (the `athlete_memory.section` column). A note carries
// its section from now on; a row written before this shipped has none, and CODE
// gives it one when it is read (`resolveSection`). No script touches Will's rows.
//
// This module also owns what the tab and Joe's block HIDE:
//   - the old "Weekly check-in ..." / "Monthly check-in ..." summary rows (the
//     check-in no longer writes summaries; it writes ONE This-week row), and
//   - a note past its expiry (activeFacts already drops those).
// And the This-week row itself: one row per check-in, 28 days, holding that
// week's recovery answer and anything short-lived the athlete said. The recovery
// strip on the tab is the last four of them.
//
// Pure, no I/O. Suite: scripts/test-memory-sections.mjs. No import from
// memory.js (memory.js imports this one).
import { noteSpan } from "./noteDates.js";

export const NOTE_SECTIONS = ["schedule", "body", "preferences", "this_week"];
export const SECTION_LABEL = { bio: "Bio", goal: "Goal", schedule: "Schedule", body: "Body", preferences: "Preferences", this_week: "This week" };
export const isNoteSection = (v) => NOTE_SECTIONS.includes(v);
// DB CHECK twin: supabase/migrations/20261003_t69c_context_sections.sql and
// api/data.js ATHLETE_COL_ALLOW.athlete_memory.values.section.

export const THIS_WEEK_DAYS = 28;
export const REMOVED_VISIBLE_DAYS = 30;

const WATCH_RE = /^\s*watching\s*:/i;
export const isWatchNote = (row) => WATCH_RE.test(String((row && row.content) || ""));

// The retired check-in summaries (T68 made them situational facts). A row the
// new check-in writes always has a section, so a row WITHOUT one that opens like
// this is a summary and stays out of sight.
const LEGACY_CHECKIN_RE = /^\s*(weekly|monthly) check-in\b/i;
export const isLegacyCheckinNote = (row) => !!row && !row.section && LEGACY_CHECKIN_RE.test(String(row.content || ""));

// Keyword defaults for a row with no stored section. Order matters: a dated
// event is Schedule before anything else, a body word beats a gear word.
const BODY_RE = /\b(injur\w*|surgery|surgical|rehab\w*|knees?|shoulders?|low back|lower back|upper back|back (?:pain|injury|issues?|problems?)|hips?|ankles?|wrists?|elbows?|pecs?|hamstrings?|quads?|glutes?|neck|achilles|core|mobility|tendon\w*|strain\w*|tear|torn|sprain\w*|concussion|asthma|diabet\w*|arthritis)\b/i;
const SCHEDULE_RE = /\b(trains?|training|sessions?|gym|garage|home gym|equipment|barbells?|racks?|dumbbells?|bands?|mornings?|evenings?|afternoons?|am|pm|class|classes|school|college|semester|exams?|finals|work|works|job|shifts?|nights?|weekdays?|weekends?|schedule|travel\w*|trip|vacation|meet|competition|tournament|season|practice|days a week|days per week|times a week|commute|kids?|baby)\b/i;
const PREF_STRONG_RE = /\b(prefers?|likes?|loves?|hates?|dislikes?|enjoys?|rpe|blunt|capped|pep talk|tone|nickname|coaching|cues?)\b/i;
const PREF_RE = /\b(prefers?|likes?|loves?|hates?|dislikes?|enjoys?|wants|rpe|percent\w*|blunt|short|brief|kg|kilos?|lbs|pounds|units?|cap|capped|minutes?|style|tone|nickname|coaching|cues?|supersets?|accessor\w+|warm[- ]?up|cardio|tempo|programmed|deload\w*)\b/i;

export function resolveSection(row, now = new Date()) {
  if (!row) return "preferences";
  if (isNoteSection(row.section)) return row.section;
  if (isWatchNote(row)) return "this_week";
  const text = String(row.content || "");
  if (noteSpan(text, now) || (row.expires_at && row.kind === "situational")) return "schedule";
  if (BODY_RE.test(text)) return "body";
  if (PREF_STRONG_RE.test(text)) return "preferences";
  if (SCHEDULE_RE.test(text)) return "schedule";
  if (PREF_RE.test(text)) return "preferences";
  return "preferences";
}

// Rows the tab and Joe's block never show. Expired rows are dropped upstream
// by activeFacts; this drops what is live but retired.
export const isHiddenRow = (row) => isLegacyCheckinNote(row);

// Active rows with their section resolved, hidden rows removed. Does NOT apply
// expiry or the deleted filter (callers pass activeFacts output).
export function visibleRows(rows, now = new Date()) {
  return (rows || []).filter((r) => r && !isHiddenRow(r)).map((r) => ({ ...r, section: resolveSection(r, now) }));
}

export function groupBySection(rows, now = new Date()) {
  const out = { schedule: [], body: [], preferences: [], this_week: [] };
  for (const r of visibleRows(rows, now)) out[r.section].push(r);
  return out;
}

// ── "Recently removed" (30 days, with Restore) ──────────────────────────────
export function recentlyRemoved(rows, now = new Date()) {
  const cut = new Date(now).getTime() - REMOVED_VISIBLE_DAYS * 864e5;
  return (rows || [])
    .filter((r) => r && r.status === "deleted" && String(r.content || "").trim() && !isLegacyCheckinNote(r) && !isWatchNote(r))
    .filter((r) => Date.parse(r.updated_at || r.created_at || "") >= cut)
    .sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0));
}

// ── the This-week row: one per check-in ─────────────────────────────────────
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayLabel = (d) => { const x = new Date(d); return `${MON[x.getUTCMonth()]} ${x.getUTCDate()}`; };
const clean = (s, max) => String(s || "").replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, max);

// recovery: the athlete's own word or two ("dialed", "flat", "running on fumes").
// note: anything short-lived they said ("school ate the week, back to 6 from
// Monday"). Both optional; returns null when there is nothing worth a row.
export function thisWeekFact({ recovery = "", note = "" } = {}, now = new Date()) {
  const rec = clean(recovery, 60), n = clean(note, 400);
  if (!rec && !n) return null;
  const parts = [`Check-in ${dayLabel(now)}.`];
  if (rec) parts.push(`Recovery: ${rec}.`);
  if (n) parts.push(`${n.charAt(0).toUpperCase()}${n.slice(1)}.`);
  return {
    content: parts.join(" "),
    kind: "situational",
    section: "this_week",
    expires_at: new Date(new Date(now).getTime() + THIS_WEEK_DAYS * 864e5).toISOString(),
    source: "athlete_said",
  };
}

const THIS_WEEK_RE = /^Check-in ([A-Z][a-z]{2} \d{1,2})\.(?: Recovery: ([^.]+)\.)?/;
// The last four check-ins as a strip: [{label:"Sep 28", word:"dialed", day:"2026-09-28", now:true}]
export function recoveryStrip(rows, now = new Date(), max = 4) {
  const found = [];
  for (const r of rows || []) {
    if (!r || r.status === "deleted" || r.section !== "this_week") continue;
    const m = String(r.content || "").match(THIS_WEEK_RE);
    if (!m || !m[2]) continue;
    const at = Date.parse(r.created_at || r.updated_at || "");
    if (!Number.isFinite(at)) continue;
    if (r.expires_at && Date.parse(r.expires_at) <= new Date(now).getTime()) continue;
    found.push({ at, label: m[1], word: m[2].trim() });
  }
  found.sort((a, b) => a.at - b.at);
  const last = found.slice(-max);
  return last.map((f, i) => ({ label: f.label, word: f.word, day: new Date(f.at).toISOString().slice(0, 10), now: i === last.length - 1 }));
}
