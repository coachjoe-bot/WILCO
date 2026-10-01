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
// S6: an optional "next"/"this" before the end day ("Wed through next Tuesday",
// BUG-3's real opener) used to drop the whole range to "unclear".
const WEEKDAY_RANGE_RE = new RegExp(`\\b(?:from\\s+)?(${WD})\\s*(?:-|–|to|through|thru|until)\\s*(?:(next|this)\\s+)?(${WD})\\b`, "i");
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
const FOR_A_MONTH_RE = /\bfor\s+(?:a|one|the)\s+month\b/i; // S6: "in a boot for a month"
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
      let n = daysBetweenWeekdayNames(m[1], m[3]);
      // "Monday through next Monday" is eight days, not one.
      if (n === 1 && m[2] && m[2].toLowerCase() === "next") n = 8;
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
  if (FOR_NEXT_MONTH_RE.test(msg) || FOR_A_MONTH_RE.test(msg)) return finish(30, "medium", "relative_span");
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

// ─── T64 S6: SCOPE OVER THE CONVERSATION (verifier BUG-3) ───────────────────
// A real trip arrives in pieces: "visiting family Wed through next Tuesday"
// (the span), then "just dumbbells up to 50lb" (the conditions), then Joe's
// day-by-day plan, then "yes set me up with that". The gate used to read ONLY
// the message in hand, so no single turn ever carried everything and the temp
// program was never written, while Joe, reading the whole transcript, said
// "Already built that for you above." Everything below reads a bounded window
// of the conversation instead. Pure: messages in, verdict out; App.jsx send()
// only executes what these return. Unit tested by scripts/test-change-scope.mjs.
//
// The window: the athlete's last 6 messages, none older than 60 minutes
// (message `at`, epoch ms, stamped by send()), plus every assistant message
// from the oldest of those on. A message with no `at` (a transcript saved
// before the stamp existed) ends the window: unknown age never counts.
export const TEMP_WINDOW = Object.freeze({ maxUserMsgs: 6, maxAgeMs: 60 * 60 * 1000 });

export function conversationWindow(messages, now = new Date(), { maxUserMsgs = TEMP_WINDOW.maxUserMsgs, maxAgeMs = TEMP_WINDOW.maxAgeMs } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const users = [];
  let start = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== "user") continue;
    const isCurrent = users.length === 0; // the message being sent is always in
    const at = Number(m.at);
    if (!isCurrent && (!Number.isFinite(at) || nowMs - at > maxAgeMs || at > nowMs + 60000)) break;
    if (users.length >= maxUserMsgs) break;
    users.unshift({ content: String(m.content || ""), at: Number.isFinite(at) ? at : nowMs, idx: i });
    start = i;
  }
  const assistants = [];
  for (let i = start; i < list.length; i++) {
    const m = list[i];
    if (m && m.role === "assistant") assistants.push({ content: String(m.content || ""), idx: i, tempSaved: !!m.tempSaved });
  }
  return { start, users, assistants };
}

// Day headers in a plan Joe wrote. Tolerant of chat formatting ("**Wednesday
// (Push, DB version):**", "Day 2 — Pull", "Thu: DB rows") but a day name only
// counts as a HEADER when punctuation or the end of the line follows it, so
// prose ("Wednesday's your push day, then pull...") never reads as a plan.
const HEADER_LEAD_RE = /^[\s>*#_•·\-–—]*(?:\d+[.)]\s+)?[*_]*/;
const HEADER_DAY_RE = /^(day\s*\d+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun)\b(.*)$/i;
const headerKey = (line) => {
  const t = String(line || "").replace(HEADER_LEAD_RE, "");
  const m = t.match(HEADER_DAY_RE);
  if (!m) return null;
  const rest = m[2] || "";
  if (!(rest.trim() === "" || /^[*_]*\s*(?::|\(|-|–|—|,|\*|\||\/)/.test(rest))) return null;
  const k = m[1].toLowerCase().replace(/\s+/g, "");
  return k.startsWith("day") ? k : k.slice(0, 3);
};
export const countPlanDays = (text) => {
  const seen = new Set();
  for (const raw of String(text || "").split("\n")) { const k = headerKey(raw); if (k) seen.add(k); }
  return seen.size;
};

// The deterministic cut of a plan out of a chat reply: from the first day header
// to the end of the last day's block, dropping a closing prose paragraph (no
// numbers in it) and markdown emphasis. The fallback when the extractor model
// returns nothing usable, so a plan Joe laid out is never lost to a timeout.
export function planSlice(text) {
  const lines = String(text || "").split("\n");
  const first = lines.findIndex((l) => headerKey(l));
  if (first < 0) return "";
  let body = lines.slice(first);
  const lastHeader = body.reduce((acc, l, i) => (headerKey(l) ? i : acc), 0);
  // After the last day's block, the first paragraph with no exercise-shaped
  // line in it (a numbered/bulleted item, sets x reps, or an @ load) is Joe
  // talking again, not the plan: cut there.
  const EXERCISE_LINE = /^\s*(?:\d+[.)]|[-•*])\s+\S|\d+\s*[x×]\s*\d+|@\s*\d/i;
  let end = body.length;
  for (let i = lastHeader + 1; i < body.length; i++) {
    if (body[i].trim() !== "") continue;
    let j = i + 1;
    while (j < body.length && body[j].trim() === "") j++;
    const para = [];
    while (j < body.length && body[j].trim() !== "") para.push(body[j++]);
    if (para.length && !para.some((l) => EXERCISE_LINE.test(l) || headerKey(l))) { end = i; break; }
  }
  body = body.slice(0, end);
  return body.map((l) => l.replace(/\*\*|__/g, "").replace(/\s+$/, "")).join("\n").trim();
}

// Is this "plan" just the athlete's regular (or current temp) program read back?
// Joe listing the week they already have must never be saved as a temp program.
const normLine = (l) => String(l || "").toLowerCase().replace(/[^a-z0-9@]+/g, " ").trim();
export function isProgramEcho(planText, programTexts = []) {
  const known = new Set();
  for (const p of programTexts) for (const l of String(p || "").split("\n")) { const n = normLine(l); if (n) known.add(n); }
  if (!known.size) return false;
  const lines = String(planText || "").split("\n").map(normLine).filter((n) => n && !headerKey(n));
  if (!lines.length) return false;
  const hits = lines.filter((n) => known.has(n)).length;
  return hits / lines.length >= 0.6;
}

// The most recent day-by-day plan Joe laid out inside the window (2+ day
// headers, not the regular program echoed back). null when there is none.
export function findRecentPlan({ messages, now = new Date(), programText = "", tempProgramText = "" } = {}) {
  const { assistants } = conversationWindow(messages, now);
  for (let i = assistants.length - 1; i >= 0; i--) {
    const a = assistants[i];
    const days = countPlanDays(a.content);
    if (days >= 2 && !isProgramEcho(planSlice(a.content), [programText, tempProgramText])) {
      return { text: a.content, idx: a.idx, days, saved: a.tempSaved };
    }
  }
  return null;
}

// Words that tie a span to a training situation. Only used on the path where
// the parser raised no flag at all, so a plain "busy this week" followed by Joe
// laying out a week can't quietly replace anyone's program.
const TEMP_CONDITION_RE = /\b(travel\w*|trip|away|visit\w*|vacation|holiday|hotel|cruise|beach|cabin|camp|garage|home gym|gym|dumbbells?|db|kettlebells?|kb|bands?|barbell|rack|platform|machines?|equipment|gear|out of town|on the road|injur\w*|boot|cast|sling|temp(?:orary)? (?:program|plan)|travel plan)\b/i;
export const hasTempCondition = (texts) => (texts || []).some((t) => TEMP_CONDITION_RE.test(String(t || "")));

// "Starting today" / "from today" opens a span; it is not a today-only scope.
const neutralizeStart = (s) => String(s || "").replace(/\b(?:starting|beginning|from)\s+(?:today|tonight)\b/gi, "");

// Scope judged over the conversation. Order (first definite read wins):
//   1. the CURRENT message's own words, a today-only statement included
//      ("actually just today" beats a span stated two messages ago);
//   2. the parser's sensed span for the current message;
//   3. the athlete's earlier in-window messages, newest first;
//   4. day headers in the plan text supplied (extractedText);
//   5. unclear: one day, low confidence.
export function conversationScope({ messages, now = new Date(), parserDays = null, programShape = null, tz = null, extractedText = "" } = {}) {
  const { users } = conversationWindow(messages, now);
  const cur = users[users.length - 1];
  const base = { programShape, tz };
  if (cur) {
    const r = changeScope({ ...base, message: neutralizeStart(cur.content), today: now });
    if (r.signal === "today_only" || r.confidence !== "low") return { ...r, source: "current" };
    const p = changeScope({ ...base, message: neutralizeStart(cur.content), today: now, parserDays });
    if (p.signal === "parser_span") return { ...p, source: "current" };
  }
  for (let i = users.length - 2; i >= 0; i--) {
    const r = changeScope({ ...base, message: neutralizeStart(users[i].content), today: new Date(users[i].at) });
    if (r.signal === "today_only") return { ...r, source: "window" };
    if (r.confidence !== "low") return { ...r, source: "window" };
  }
  const headerDays = countPlanDays(extractedText);
  if (headerDays >= 2) return { days: clampDays(headerDays), confidence: "medium", signal: "day_headers", source: "plan" };
  return { days: 1, confidence: "low", signal: "unclear", source: null };
}

// BEFORE Joe replies: is any of this in play, and does an explicit ask ("set me
// up with that temporary program") have a plan to save? explicitAsk comes from
// chatRouting.asksTempProgram. The write itself is App.jsx's; this only says
// which plan, so Joe's context can state the truth before he speaks.
export function tempTurnBefore({ messages, now = new Date(), athlete = {}, explicitAsk = false, fromQuickLog = false } = {}) {
  const programText = athlete?.program_text || "";
  const tempProgramText = athlete?.temp_program_text || "";
  const plan = findRecentPlan({ messages, now, programText, tempProgramText });
  const scope = conversationScope({ messages, now });
  let writePlan = null;
  let reason = null;
  if (explicitAsk && !fromQuickLog) {
    if (!plan) reason = "no_plan_in_window";
    else if (scope.source === "current" && scope.signal === "today_only") reason = "today_only";
    else if (plan.saved && tempProgramText) reason = "already_saved";
    else { writePlan = plan; reason = "explicit_ask"; }
  }
  const inPlay = !fromQuickLog && (explicitAsk || !!tempProgramText || !!plan || scope.days >= 2);
  return { explicitAsk: !!explicitAsk, plan, writePlan, reason, scope, inPlay };
}

// AFTER Joe replies: write a temp program from what he just laid out?
//   - reply is a day-by-day plan (2+ day headers, not an echo) AND the
//     conversation carries a multi-day span AND (the parser flagged it, or the
//     window names a training condition): write from the REPLY.
//   - the parser flagged is_temp_program_update and the conversation (or the
//     plan's own headers) spans 2+ days: write from the reply when it is a
//     plan, else from the most recent unsaved plan in the window, else the
//     legacy extraction of the reply (kept: Joe's plan may use "Push day:"
//     headers with no day names at all).
// Never: a Quick Log send, a turn where Joe called prefill_log_sheet (his own
// today-only call), a today-only scope, or a turn whose explicit ask already
// wrote before the reply.
export function decideTempWrite({ messages, now = new Date(), reply = "", flagged = false, parserDays = null, athlete = {}, fromQuickLog = false, joeHandledToday = false, explicitWrote = false, tz = null } = {}) {
  const no = (reason) => ({ write: false, source: null, planText: null, reason });
  if (fromQuickLog) return no("from_quick_log");
  if (explicitWrote) return no("explicit_ask_wrote");
  if (joeHandledToday) return no("joe_prefilled_today");
  const programTexts = [athlete?.program_text || "", athlete?.temp_program_text || ""];
  const replyDays = countPlanDays(reply);
  const replyIsPlan = replyDays >= 2 && !isProgramEcho(planSlice(reply), programTexts);
  const words = conversationScope({ messages, now, parserDays, tz });
  if (words.signal === "today_only") return no("today_only");
  const { users } = conversationWindow(messages, now);
  if (replyIsPlan && words.days >= 2 && (flagged || hasTempCondition(users.map((u) => u.content)))) {
    return { write: true, source: "reply", planText: reply, reason: "plan_in_reply", scope: words };
  }
  if (flagged) {
    const recent = replyIsPlan ? null : findRecentPlan({ messages, now, programText: programTexts[0], tempProgramText: programTexts[1] });
    const usable = recent && !(recent.saved && athlete?.temp_program_text) ? recent : null;
    const scope = conversationScope({ messages, now, parserDays, tz, extractedText: replyIsPlan ? reply : (usable ? usable.text : "") });
    if (scope.days < 2) return no("single_day");
    if (replyIsPlan) return { write: true, source: "reply", planText: reply, reason: "flag_plan_in_reply", scope };
    if (usable) return { write: true, source: "recent_plan", planText: usable.text, reason: "flag_recent_plan", scope };
    return { write: true, source: "legacy_reply", planText: reply, reason: "flag_legacy", scope };
  }
  return no(replyIsPlan ? "no_multi_day_scope" : "no_plan");
}

// The fact Joe gets before he speaks whenever a temp program is in play. One
// line, code-computed, so he can never say "already built" about something
// unsaved (verifier BUG-3). recentPlanFound: tempTurnBefore().plan.
export function tempProgramFact({ athlete = {}, recentPlanFound = null, savingNow = false } = {}) {
  const head = "TEMP PROGRAM (app fact, this turn):";
  if (savingNow) {
    return `${head} the app is saving the day-by-day plan you laid out earlier in this conversation as their temporary program right now and confirms it in its own line. Do not lay the plan out again; a short acknowledgment is enough.`;
  }
  const saved = String(athlete?.temp_program_text || "").trim();
  if (saved) {
    const first = saved.split("\n").map((l) => l.trim()).find(Boolean) || "";
    const newer = recentPlanFound && !recentPlanFound.saved
      ? " A newer plan you laid out in this conversation has NOT been saved; never say it is."
      : "";
    return `${head} a temporary program IS saved and active; its first line is "${first.slice(0, 80)}".${newer}`;
  }
  if (recentPlanFound) {
    return `${head} NO temporary program is saved. The day-by-day plan you laid out earlier in this conversation has NOT been saved; never say it is built, set or saved. It saves when they ask for it.`;
  }
  return `${head} NO temporary program is saved, and you have not laid out a day-by-day plan in this conversation. Never say one is built or saved; if they want one, lay out the days first, one header per day.`;
}

// Is an extractor's output actually a program? Live S6 pass, 09-28: on a turn
// where Joe only ASKED about equipment, the legacy flagged path extracted his
// reply and the extractor answered in prose ("I don't have a program to
// extract..."), which was saved as the temp program with a confirmation line.
// Two or more exercise-shaped lines (sets x reps or an @ load), and no
// refusal/apology opener, or it is not saved.
const EXERCISE_SHAPE = /\d+\s*[x×]\s*\d+|@\s*\d|\b\d+\s*sets?\b/i;
const REFUSAL_OPENER = /^\s*(?:i\b|i'm\b|sorry|there(?:'s| is) no|no (?:program|training|plan)|unable|this message|the message|none\b)/i;
export function looksLikePlanText(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length || REFUSAL_OPENER.test(lines[0])) return false;
  return lines.filter((l) => EXERCISE_SHAPE.test(l)).length >= 2;
}

// The app's one confirmation line after a temp program write (unchanged copy,
// moved here so the coach-locked wording is tested).
export const tempConfirmLine = ({ locked = false } = {}) => locked
  ? "✈️ Got it, I've set you up with a temporary program for while you're away. Your coach's program is untouched and waiting; I've let them know you're on the road. Tell me when you're back."
  : "✈️ Got it, I've set a temporary program for while you're away. Tell me when you're back and I'll switch you to your regular programming.";

// ─── T67: a today-only change is never a program rec (AI contract rule 4) ────
// The card already says a change scoped to one session is never a temp program;
// the same scope read (conversationScope, computed before Joe speaks) now also
// decides his propose_program_rec on that turn. Real-model pass 09-29: "the
// squat racks are all taken today, swap my first lift for something I can do
// with dumbbells", no workout started, and Joe staged a PROGRAM REC 3 of 5.
// The athlete's own words win both ways: a change they say should outlive today
// ("from now on", "in my program", "every week") keeps the rec.
const OUTLIVES_TODAY_RE = /\b(from now on|going forward|moving forward|for good|permanently|for the (?:rest of the )?(?:block|program|cycle)|every (?:week|time|session|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each week|in (?:my|the) (?:program|plan|split)|(?:my|the) program|(?:my|the) new (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|day \d|session|workout)|template)\b/i;
export const outlivesToday = (message) => OUTLIVES_TODAY_RE.test(String(message || ""));
const todayOnlyNow = (scope) => !!(scope && scope.signal === "today_only" && scope.source === "current");
// scope: tempTurnBefore().scope / conversationScope(). true = the rec stands.
export function keepRecOnScope(scope, message) {
  return !(todayOnlyNow(scope) && !outlivesToday(message));
}
// The fact Joe gets before he speaks on that turn (dynamic context). Not on a
// log: a log saying "today" is a record, not a change request.
export function changeScopeFact({ scope, message = "", isLogTurn = false } = {}) {
  if (isLogTurn || !todayOnlyNow(scope) || outlivesToday(message)) return "";
  return "CHANGE SCOPE (app fact, this turn): what they are asking to change covers today's session only. It is not a program change, so no program rec: give them today's swap in chat, and they put it on their log sheet when they start. Their saved program stays as it is.";
}
