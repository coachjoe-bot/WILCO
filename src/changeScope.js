// ─── CHANGE SCOPE (T64 Fix 4) ─────────────────────────────────────────────────
// Does a described equipment/condition change cover ONE training day, or two or
// more? The classifier that sets is_temp_program_update has no notion of
// duration at all — it fires on any mention of equipment/condition limitations,
// a single missing item for today included. A one-day change must only ever
// touch today's log-sheet draft; a real multi-day situation gets a temp
// program. This is the deterministic backstop: no model judgment call decides
// scope, App.jsx's write branch just reads `.days`.
//
// Deliberately conservative: a bare mention of travel/hotel/equipment with NO
// stated duration is NOT itself treated as multi-day (that was the whole bug —
// "hotel gym" alone used to be enough to fire a full temp program). Only an
// EXPLICIT duration signal (today/this session, a named weekday, "this week",
// "for N days", a described trip span) or 2+ day headers in an extracted plan
// pushes the count to 2+. Anything genuinely unclear defaults to 1 (today-only,
// the safer default — it never silently overwrites the real program) with
// confidence:"low" so the caller can let the model ask a plain clarifying
// question in its own reply rather than guessing either way.
//
// React-free; unit tested by scripts/test-change-scope.mjs.

const TODAY_ONLY_RE = /\b(today|tonight|this (?:session|workout|lift)|right now|just today)\b/i;
const UNTIL_DAY_RE = /\b(?:until|through|till)\s+(mon|tues?|wednes|thurs?|fri|satur|sun)[a-z]*\b/i;
const FOR_N_DAYS_RE = /\bfor\s+(?:the\s+next\s+)?(\d{1,2})\s*(?:day|days)\b/i;
const FOR_A_FEW_DAYS_RE = /\bfor\s+(?:a\s+)?(?:few|couple(?:\s+of)?)\s+days\b/i;
const FOR_A_WEEK_RE = /\bfor\s+(?:a|the|another)\s+week\b/i;
const THIS_WEEK_RE = /\bthis\s+week\b/i;
const REST_OF_WEEK_RE = /\b(?:rest|remainder)\s+of\s+(?:the\s+)?week\b/i;
const REST_OF_TRIP_RE = /\b(?:rest|remainder)\s+of\s+(?:the\s+)?trip\b/i;
const TRAVELING_FOR_RE = /\btravel(?:ing|led)?\s+for\s+(?:a|the)\s+week\b/i;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// A rough, tolerant count of distinct day-header-looking lines in an extracted
// program snippet — a real multi-day signal even with no duration WORDS at all
// (Joe's own reply laying out Mon/Wed/Fri describes a multi-day plan whatever
// the athlete's original phrasing was). Not the primary signal; a fallback.
const countDayHeaders = (text) => {
  if (!text) return 0;
  const seen = new Set();
  for (const raw of String(text).split("\n")) {
    const m = raw.trim().match(/^(?:day\s*\d+|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i);
    if (m) seen.add(m[0].toLowerCase().replace(/\s+/g, ""));
  }
  return seen.size;
};

// Days from `today` through the next occurrence of `targetName`, inclusive of
// today (so "until Thursday" said on a Monday covers Mon/Tue/Wed/Thu = 4).
const daysUntilWeekday = (today, targetName) => {
  const idx = WEEKDAYS.findIndex((d) => d.startsWith(String(targetName || "").toLowerCase()));
  const t = today instanceof Date ? today : new Date(today);
  if (idx < 0 || Number.isNaN(t.getTime())) return null;
  const cur = t.getUTCDay();
  let diff = idx - cur;
  if (diff <= 0) diff += 7;
  return diff + 1;
};

export function changeScope({ message = "", extractedText = "", programShape = null, today = new Date() } = {}) {
  const msg = String(message || "");
  const hasExplicitSpan = UNTIL_DAY_RE.test(msg) || FOR_N_DAYS_RE.test(msg) || THIS_WEEK_RE.test(msg)
    || FOR_A_WEEK_RE.test(msg) || FOR_A_FEW_DAYS_RE.test(msg) || REST_OF_WEEK_RE.test(msg)
    || REST_OF_TRIP_RE.test(msg) || TRAVELING_FOR_RE.test(msg);

  // Explicit "today"/"this session" wins over everything else UNLESS the same
  // message also states a real span ("I'm home today but traveling this week
  // starting tomorrow" — rare, but the span should win when both are present).
  if (TODAY_ONLY_RE.test(msg) && !hasExplicitSpan) {
    return { days: 1, confidence: "high" };
  }

  const untilMatch = msg.match(UNTIL_DAY_RE);
  if (untilMatch) {
    const n = daysUntilWeekday(today, untilMatch[1]);
    if (n != null) return { days: n, confidence: "high" };
  }

  const forN = msg.match(FOR_N_DAYS_RE);
  if (forN) {
    const n = parseInt(forN[1], 10);
    if (Number.isFinite(n) && n >= 1) return { days: n, confidence: "high" };
  }

  if (FOR_A_FEW_DAYS_RE.test(msg)) return { days: 3, confidence: "medium" };

  const perWeek = (programShape && Number.isFinite(programShape.trainingDaysPerWeek) && programShape.trainingDaysPerWeek >= 1)
    ? programShape.trainingDaysPerWeek : null;

  if (THIS_WEEK_RE.test(msg) || REST_OF_WEEK_RE.test(msg) || FOR_A_WEEK_RE.test(msg) || TRAVELING_FOR_RE.test(msg)) {
    return { days: perWeek || 7, confidence: perWeek ? "high" : "medium" };
  }
  if (REST_OF_TRIP_RE.test(msg)) {
    return { days: perWeek || 5, confidence: "medium" };
  }

  // No duration language from the athlete at all — fall back to what the
  // extracted plan itself describes. 2+ distinct day headers is a real
  // multi-day plan regardless of how the athlete originally phrased the ask.
  const headerDays = countDayHeaders(extractedText);
  if (headerDays >= 2) return { days: headerDays, confidence: "medium" };

  // Genuinely unclear: a bare "no shoes today" / "hotel gym" mention with
  // nothing else. Today-only is the safer default (never silently overwrites
  // the real program); low confidence tells the caller this was a guess, not a
  // read, so it can let the model ask rather than assert.
  return { days: 1, confidence: "low" };
}
