// ─── CHANGE SCOPE (T64 Fix 4, extended in S1c) ─────────────────────────────
// Does a described equipment/condition change cover ONE training day, or two
// or more? The classifier that sets is_temp_program_update has no notion of
// duration at all — it fires on any mention of equipment/condition
// limitations, a single missing item for today included. A one-day change
// must only ever touch today's log-sheet draft; a real multi-day situation
// gets a temp program. This is the deterministic backstop: no model judgment
// call decides scope, App.jsx's write branch just reads `.days`.
//
// Deliberately conservative: a bare mention of travel/hotel/equipment with NO
// stated duration is NOT itself treated as multi-day (that was the whole
// original bug — "hotel gym" alone used to be enough to fire a full temp
// program). Only an EXPLICIT duration signal (today/this session, a named
// weekday or weekday range, a date or date range, a relative span like "next
// two weeks", or 2+ day headers in an extracted plan) pushes the count to
// 2+. Anything genuinely unclear defaults to 1 (today-only, the safer
// default — it never silently overwrites the real program) with
// confidence:"low" so the caller can let the model ask a plain clarifying
// question in its own reply rather than guessing either way.
//
// TIMEZONE: `today` is a Date the caller already has "now" in — at the real
// call site (App.jsx, browser) that's simply `new Date()`, whose local
// getters (getDay/getDate/getMonth/getFullYear/getHours) already read out in
// the athlete's own device timezone. The bug this module used to have was
// reading `getUTCDay()` instead — on a US-Eastern evening that rolls the
// calendar day into UTC's tomorrow and throws every weekday computation off
// by one. Every date/weekday computation below goes through `localParts()`,
// which uses local getters by default and an IANA zone (matching how
// `athletes.proof_timezone` is used elsewhere, e.g. `api/push.js`
// `localHourIn`) when an explicit `tz` is passed — useful for a server-side
// caller, or for tests that want a deterministic zone regardless of the
// machine running them.
//
// React-free; unit tested by scripts/test-change-scope.mjs.

const WD = "(?:sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_SRC = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUM_WORD_RE = "(one|two|three|four|five|six|seven|eight|nine|ten|\\d{1,2})";
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const TODAY_ONLY_RE = /\b(today|tonight|this (?:session|workout|lift)|right now|just today)\b/i;
const TOMORROW_ALONE_RE = /\btomorrow\b/i;

// ── Signal 1: weekday ranges ("Friday to Sunday", "Fri-Sun", "Thursday and
// Friday") plus the implicit-today-start form ("until Thursday"). ──────────
const WEEKDAY_RANGE_RE = new RegExp(`\\b(?:from\\s+)?(${WD})\\s*(?:-|–|to|through|thru|until)\\s*(${WD})\\b`, "i");
const WEEKDAY_AND_RE = new RegExp(`\\b(${WD})\\s+and\\s+(${WD})\\b`, "i");
const UNTIL_DAY_RE = new RegExp(`\\b(?:until|through|till|thru)\\s+(${WD})\\b`, "i");

// ── Signal 2: date ranges. ──────────────────────────────────────────────
const ORDINAL_RANGE_RE = /\bfrom\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|through|thru|until|-|–)\s*the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
const MONTH_DAY_RANGE_RE = new RegExp(`\\b${MONTH_SRC}\\.?\\s+(\\d{1,2})\\s*(?:-|–|to|through|thru)\\s*(\\d{1,2})\\b`, "i");
const NUMERIC_DATE_RANGE_RE = /\b(\d{1,2})\/(\d{1,2})\s*(?:to|-|–|through|thru)\s*(\d{1,2})\/(\d{1,2})\b/;
const THROUGH_MONTH_DAY_RE = new RegExp(`\\b(?:through|until|till|thru)\\s+${MONTH_SRC}\\.?\\s+(\\d{1,2})\\b`, "i");
const UNTIL_ORDINAL_RE = /\b(?:until|through|till|thru)\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;

// ── Signal 3: relative spans. ───────────────────────────────────────────
const TOMORROW_AND_DAY_AFTER_RE = /\btomorrow\s+and\s+the\s+day\s+after\b/i;
const NEXT_N_DAYS_RE = new RegExp(`\\b(?:the\\s+)?next\\s+${NUM_WORD_RE}\\s+days\\b`, "i");
const NEXT_N_WEEKS_RE = new RegExp(`\\bnext\\s+${NUM_WORD_RE}\\s+weeks\\b`, "i");
const FOR_N_WEEKS_RE = new RegExp(`\\bfor\\s+(?:the\\s+next\\s+|another\\s+)?${NUM_WORD_RE}\\s+weeks?\\b`, "i");
const FOR_NEXT_MONTH_RE = /\bfor\s+(?:the\s+)?next\s+month\b/i;
const ALL_NEXT_WEEK_RE = /\ball\s+next\s+week\b/i;
const ALL_WEEK_RE = /\ball\s+week\b/i;
const WEEKEND_RE = /\b(?:over\s+the\s+weekend|through\s+the\s+weekend|this\s+weekend)\b/i;
const TIL_RETURN_RE = /\b(?:til+|until)\s+i\s+get\s+back\b(?:\s*,?\s*(next\s+month|sunday|monday|tuesday|wednesday|thursday|friday|saturday))?/i;
const FOR_A_WHILE_RE = /\bfor\s+a\s+while\b/i;
const FORESEEABLE_FUTURE_RE = /\bfor\s+the\s+foreseeable\s+future\b/i;
const FOR_N_DAYS_RE = /\bfor\s+(?:the\s+next\s+)?(\d{1,2})\s*(?:day|days)\b/i;
const FOR_A_FEW_DAYS_RE = /\bfor\s+(?:a\s+)?(?:few|couple(?:\s+of)?)\s+days\b/i;
const FOR_A_WEEK_RE = /\bfor\s+(?:a|the|another)\s+week\b/i;
const THIS_WEEK_RE = /\bthis\s+week\b/i;
const REST_OF_WEEK_RE = /\b(?:rest|remainder)\s+of\s+(?:the\s+)?week\b/i;
const REST_OF_TRIP_RE = /\b(?:rest|remainder)\s+of\s+(?:the\s+)?trip\b/i;
const TRAVELING_FOR_RE = /\btravel(?:ing|led)?\s+for\s+(?:a|the)\s+week\b/i;

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

// ── Local-time helpers ──────────────────────────────────────────────────
// Returns the calendar/clock parts of `date` as seen locally: by the runtime's
// own local timezone when `tz` is omitted (the athlete's device zone, at the
// real browser call site), or by the given IANA zone when supplied (same
// concept as `athletes.proof_timezone`, consumed in `api/push.js`
// `localHourIn` / `api/trigger-proof-feed.js`).
const WEEKDAY_ABBR_TO_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const localParts = (date, tz) => {
  const d = date instanceof Date ? date : new Date(date);
  if (tz) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return {
      year: parseInt(map.year, 10),
      month: parseInt(map.month, 10) - 1, // 0-based, matches Date#getMonth
      day: parseInt(map.day, 10),
      weekday: WEEKDAY_ABBR_TO_IDX[map.weekday],
      hour: parseInt(map.hour, 10) % 24,
    };
  }
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), weekday: d.getDay(), hour: d.getHours() };
};

const findWeekdayIdx = (name) => WEEKDAYS.findIndex((d) => d.startsWith(String(name || "").toLowerCase()));

const MONTH_KEY_TO_IDX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const findMonth1based = (name) => MONTH_KEY_TO_IDX[String(name || "").toLowerCase().slice(0, 3)] || null;

// Days from `today` through the next occurrence of `targetName`, inclusive of
// today (so "until Thursday" said on a Monday covers Mon/Tue/Wed/Thu = 4).
// Uses the athlete's LOCAL day, not UTC — see the file-header note.
const daysUntilWeekday = (today, targetName, tz) => {
  const idx = findWeekdayIdx(targetName);
  if (idx < 0) return null;
  const { weekday: cur } = localParts(today, tz);
  let diff = idx - cur;
  if (diff <= 0) diff += 7;
  return diff + 1;
};

// A range between two named weekdays, inclusive both ends, wrapping forward
// through the week (so "Friday to Sunday" = 3, "Friday through Monday" = 4,
// "Thursday and Friday" = 2). Independent of `today` — a stated range is a
// fixed span regardless of which day it is asked about.
const daysBetweenWeekdayNames = (name1, name2) => {
  const i1 = findWeekdayIdx(name1);
  const i2 = findWeekdayIdx(name2);
  if (i1 < 0 || i2 < 0) return null;
  return ((i2 - i1 + 7) % 7) + 1;
};

// Pure calendar-date arithmetic via the UTC epoch trick: Date.UTC(y,m,d) is
// used only as a stable "day number," never as an actual instant, so this is
// immune to DST and to the running machine's own timezone.
const spanDays = (y1, m1, d1, y2, m2, d2) => Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;

const clampDays = (n) => Math.max(1, Math.min(60, Math.round(n)));

const wordToNum = (w) => {
  if (w == null) return null;
  const s = String(w).toLowerCase();
  if (NUM_WORDS[s] != null) return NUM_WORDS[s];
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};

function scopeFromWords({ message = "", extractedText = "", programShape = null, today = new Date(), tz = null } = {}) {
  const msg = String(message || "");
  const perWeek = (programShape && Number.isFinite(programShape.trainingDaysPerWeek) && programShape.trainingDaysPerWeek >= 1)
    ? programShape.trainingDaysPerWeek : null;
  const todayParts = localParts(today, tz);

  const finish = (days, confidence, signal) => {
    const result = { days: clampDays(days), confidence, signal };
    if (perWeek) result.trainingDays = Math.max(0, Math.min(result.days, Math.round(result.days * perWeek / 7)));
    return result;
  };

  // ── Signal 1: weekday ranges ("Friday to Sunday", "Fri-Sun", "Thursday
  // and Friday", "from Friday until Sunday"). Checked before the plain
  // "until Thursday" form so a stated START day (not today) is honored. ──
  {
    const m = msg.match(WEEKDAY_RANGE_RE);
    if (m) {
      const n = daysBetweenWeekdayNames(m[1], m[2]);
      if (n != null) return finish(n, "high", "weekday_range");
    }
  }
  {
    const m = msg.match(WEEKDAY_AND_RE);
    if (m) {
      const n = daysBetweenWeekdayNames(m[1], m[2]);
      if (n != null) return finish(n, "high", "weekday_range");
    }
  }

  // ── Signal 2: date ranges. ──────────────────────────────────────────
  {
    const m = msg.match(ORDINAL_RANGE_RE);
    if (m) {
      const day1 = parseInt(m[1], 10), day2 = parseInt(m[2], 10);
      const y = todayParts.year, mo = todayParts.month + 1;
      let n = spanDays(y, mo, day1, y, mo, day2);
      if (n <= 0) { const nm = mo === 12 ? 1 : mo + 1, ny = mo === 12 ? y + 1 : y; n = spanDays(y, mo, day1, ny, nm, day2); }
      return finish(n, "high", "date_range");
    }
  }
  {
    const m = msg.match(MONTH_DAY_RANGE_RE);
    if (m) {
      const mo = findMonth1based(m[1]);
      const day1 = parseInt(m[2], 10), day2 = parseInt(m[3], 10);
      if (mo) {
        const y = todayParts.year;
        let n = spanDays(y, mo, day1, y, mo, day2);
        if (n <= 0) { const nm = mo === 12 ? 1 : mo + 1, ny = mo === 12 ? y + 1 : y; n = spanDays(y, mo, day1, ny, nm, day2); }
        return finish(n, "high", "date_range");
      }
    }
  }
  {
    const m = msg.match(NUMERIC_DATE_RANGE_RE);
    if (m) {
      const [, mo1, d1, mo2, d2] = m.map(Number);
      const y = todayParts.year;
      let n = spanDays(y, mo1, d1, y, mo2, d2);
      if (n <= 0) n = spanDays(y, mo1, d1, y + 1, mo2, d2);
      return finish(n, "high", "date_range");
    }
  }
  {
    const m = msg.match(THROUGH_MONTH_DAY_RE);
    if (m) {
      const mo = findMonth1based(m[1]);
      const day = parseInt(m[2], 10);
      if (mo) {
        const y = todayParts.year, tm = todayParts.month + 1, td = todayParts.day;
        let n = spanDays(y, tm, td, y, mo, day);
        if (n <= 0) n = spanDays(y, tm, td, y + 1, mo, day);
        return finish(n, "high", "date_range");
      }
    }
  }
  {
    const m = msg.match(UNTIL_ORDINAL_RE);
    if (m) {
      const day = parseInt(m[1], 10);
      const y = todayParts.year, tm = todayParts.month + 1, td = todayParts.day;
      let n = spanDays(y, tm, td, y, tm, day);
      if (n <= 0) { const nm = tm === 12 ? 1 : tm + 1, ny = tm === 12 ? y + 1 : y; n = spanDays(y, tm, td, ny, nm, day); }
      return finish(n, "high", "date_range");
    }
  }

  // ── Weekday range, implicit-today-start form ("until Thursday", no
  // travel word at all, no stated starting day). ──────────────────────
  {
    const m = msg.match(UNTIL_DAY_RE);
    if (m) {
      const n = daysUntilWeekday(today, m[1], tz);
      if (n != null) return finish(n, "high", "weekday_range");
    }
  }

  // ── Signal 3: relative spans. ───────────────────────────────────────
  if (TOMORROW_AND_DAY_AFTER_RE.test(msg)) return finish(2, "high", "relative_span");
  {
    const m = msg.match(NEXT_N_DAYS_RE);
    if (m) { const n = wordToNum(m[1]); if (n) return finish(n, "high", "relative_span"); }
  }
  {
    const m = msg.match(NEXT_N_WEEKS_RE);
    if (m) { const n = wordToNum(m[1]); if (n) return finish(n * 7, "high", "relative_span"); }
  }
  {
    const m = msg.match(FOR_N_WEEKS_RE);
    if (m) { const n = wordToNum(m[1]); if (n) return finish(n * 7, "high", "relative_span"); }
  }
  if (FOR_NEXT_MONTH_RE.test(msg)) return finish(30, "medium", "relative_span");
  if (ALL_NEXT_WEEK_RE.test(msg)) return finish(perWeek || 7, perWeek ? "high" : "medium", "relative_span");
  if (ALL_WEEK_RE.test(msg)) return finish(perWeek || 7, perWeek ? "high" : "medium", "relative_span");
  if (WEEKEND_RE.test(msg)) return finish(2, "medium", "relative_span");
  {
    const m = msg.match(TIL_RETURN_RE);
    if (m && m[1]) {
      const stated = m[1].trim().toLowerCase();
      if (stated === "next month") return finish(30, "medium", "relative_span");
      const n = daysUntilWeekday(today, stated, tz);
      if (n != null) return finish(n, "high", "relative_span");
    }
    // "til/until I get back" with NO stated return: deliberately falls
    // through to the conservative default below, not treated as multi-day.
  }
  if (FOR_A_WHILE_RE.test(msg)) return finish(7, "medium", "relative_span");
  if (FORESEEABLE_FUTURE_RE.test(msg)) return finish(14, "medium", "relative_span");
  {
    const m = msg.match(FOR_N_DAYS_RE);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n >= 1) return finish(n, "high", "relative_span"); }
  }
  if (FOR_A_FEW_DAYS_RE.test(msg)) return finish(3, "medium", "relative_span");
  if (THIS_WEEK_RE.test(msg) || REST_OF_WEEK_RE.test(msg) || FOR_A_WEEK_RE.test(msg) || TRAVELING_FOR_RE.test(msg)) {
    return finish(perWeek || 7, perWeek ? "high" : "medium", "relative_span");
  }
  if (REST_OF_TRIP_RE.test(msg)) return finish(perWeek || 5, "medium", "relative_span");

  // ── Single-day forms that must stay 1, checked only once nothing above
  // matched (a message can contain "tomorrow" as part of a multi-day
  // phrase, which is caught earlier). ──────────────────────────────────
  if (TODAY_ONLY_RE.test(msg)) return finish(1, "high", "today_only");
  if (TOMORROW_ALONE_RE.test(msg)) return finish(1, "high", "today_only");

  // No duration language from the athlete at all — fall back to what the
  // extracted plan itself describes. 2+ distinct day headers is a real
  // multi-day plan regardless of how the athlete originally phrased the ask.
  const headerDays = countDayHeaders(extractedText);
  if (headerDays >= 2) return finish(headerDays, "medium", "day_headers");

  // Genuinely unclear: a bare "no shoes today" / "hotel gym" mention, or a
  // lone weekday name ("holiday monday") with nothing else. Today-only is
  // the safer default (never silently overwrites the real program); low
  // confidence tells the caller this was a guess, not a read, so it can let
  // the model ask rather than assert.
  return finish(1, "low", "unclear");
}

// The exported gate. Words are read two ways and code decides (AI contract,
// rule 1 and rule 4): the phrase signals above are exact but have a long tail
// of wordings they miss ("Wed through next Tuesday", "in a boot for a month");
// the parser reads sentences well but must not decide alone. So:
//   - a phrase signal with real confidence wins, including "today only";
//   - when the phrases are UNCLEAR, the parser's stated span (temp_span_days,
//     sensed from the athlete's own words, null when no duration was stated)
//     fills in;
//   - nothing stated anywhere stays one day, low confidence, and Joe asks.
export function changeScope({ parserDays = null, ...rest } = {}) {
  const words = scopeFromWords(rest);
  const n = Number(parserDays);
  if (words.confidence === "low" && Number.isInteger(n) && n >= 2) {
    const out = { days: clampDays(n), confidence: "medium", signal: "parser_span" };
    const perWeek = rest.programShape && Number.isFinite(rest.programShape.trainingDaysPerWeek) && rest.programShape.trainingDaysPerWeek >= 1
      ? rest.programShape.trainingDaysPerWeek : null;
    if (perWeek) out.trainingDays = Math.max(0, Math.min(out.days, Math.round(out.days * perWeek / 7)));
    return out;
  }
  return words;
}
