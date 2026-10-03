// ─── DATED NOTES (T69-C, Will 10-01 round 1 + the 08-09 replay case) ─────────
// "A note with a clear date in it drops when the date passes, without asking."
// Two halves, both code:
//   1. A note that says "tomorrow", "next week", "this block", "after Friday"
//      is stale the moment the day turns, and nothing reviewed it. Will's own
//      goal row "... will set new bench target after maxing out tomorrow ..."
//      lived on his tab for seven weeks. So a note with a relative time word
//      cannot be saved without an expiry (`needsDate`), the same pattern as
//      `blockEndRejects` in src/memory.js. The expiry makes it drop by itself.
//   2. A note that names a calendar date ("Meet Nov 14", "Oct 26 to 30 exam
//      week") gets that date as its expiry without anyone asking (`expiryFromText`),
//      and carries a countdown computed here, never by Joe (`countdownLine`).
// Pure, no I/O. Dates are UTC days: a note drops at noon UTC the day AFTER its
// last date, so a US evening on the day itself still shows it.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY = "(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?";

// A relative time word. Deliberately a list, not "any date-ish word": a
// schedule ("trains Monday, Wednesday, Friday"), a recurring habit ("sleeps 8
// hours") and a plain history note must save as they are.
const RELATIVE_RE = new RegExp([
  "\\b(?:tomorrow|tonight|yesterday|day after tomorrow)\\b",
  `\\b(?:this|next|last|coming|upcoming)\\s+(?:week|weekend|month|block|cycle|phase|mesocycle|morning|afternoon|evening|${WEEKDAY})\\b`,
  `\\b(?:after|until|till|before|by)\\s+(?:this\\s+|next\\s+|the\\s+)?(?:${WEEKDAY}|weekend|week)\\b`,
  "\\bin\\s+(?:a|an|one|two|three|four|five|six|seven|eight|\\d+)\\s+(?:couple of\\s+|few\\s+)?(?:days?|weeks?|months?)\\b",
  "\\b(?:a few|a couple of|couple of|few)\\s+(?:days|weeks|months)\\s+(?:ago|from now)\\b",
  "\\blater\\s+(?:today|this\\s+\\w+)\\b",
].join("|"), "i");

export const relativeTimeWord = (text) => {
  const m = String(text || "").match(RELATIVE_RE);
  return m ? m[0] : null;
};

export const NEEDS_DATE = "Not saved: a note that says \"tomorrow\" or \"next week\" goes out of date by itself. Say the actual date (like Oct 12) so it can drop off when the day passes.";

const dayMs = 86400000;
const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const futureExpiry = (expires_at, now) => {
  const t = Date.parse(expires_at || "");
  return Number.isFinite(t) && t > new Date(now).getTime();
};

// null when the note is fine; "needs_date" when it has a relative time word and
// no expiry in the future. Code-authored "Watching:" notes carry their own.
export function needsDate(text, expires_at, now = new Date()) {
  const t = String(text || "");
  if (/^\s*Watching:/i.test(t)) return null;
  if (!relativeTimeWord(t)) return null;
  return futureExpiry(expires_at, now) ? null : "needs_date";
}

// ── explicit dates in a note ─────────────────────────────────────────────────
// Verbs that put a date in the past ("started lifting Mar 3", "hit 300 on Aug
// 3"): such a note is history and never expires on its date.
const PAST_CUE = /\b(started|began|since|was|were|had|hit|did|got|set|joined|finished|completed|injured|tore|torn|broke|surgery|ago|born|graduated)\b/i;

// Every explicit date: ISO, "Nov 14", "Nov 14, 2026", "Oct 26 to 30" (a range
// ends on its second day). Year-less dates resolve to the NEXT time that day
// comes, but only when it is within HORIZON_DAYS; beyond that, or already past,
// the date is not an event worth auto-expiring.
const HORIZON_DAYS = 180;
export function explicitDates(text, now = new Date()) {
  const t = String(text || "");
  const today = utcDay(new Date(now));
  const out = [];
  const push = (y, mo, d, hasYear) => {
    const ms = Date.UTC(y, mo, d);
    if (!Number.isFinite(ms) || new Date(ms).getUTCMonth() !== mo) return; // Feb 31
    out.push({ ms, hasYear, day: isoDay(ms) });
  };
  const yr = new Date(now).getUTCFullYear();
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(+m[1], +m[2] - 1, +m[3], true);
  const re = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*(?:to|through|thru|-|–)\\s*(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(\\d{4}))?\\b`, "gi");
  for (const m of t.matchAll(re)) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith("sept") ? 4 : 3)];
    if (mo == null) continue;
    const hasYear = !!m[4];
    const d1 = +m[2];
    if (d1 < 1 || d1 > 31) continue;
    const d2 = m[3] && +m[3] >= d1 && +m[3] <= 31 ? +m[3] : null;
    // A year-less date is the NEXT time that day comes. A range is judged by
    // its LAST day, so "Oct 1 to 5" on Oct 3 is this year's, still running.
    let y = hasYear ? +m[4] : yr;
    if (!hasYear && Date.UTC(y, mo, d2 || d1) < today) y += 1;
    push(y, mo, d1, hasYear);
    if (d2) push(y, mo, d2, hasYear);
  }
  return out.sort((a, b) => a.ms - b.ms);
}

// The span of the event a note names: first and last explicit date, or null
// when none, or when it reads as history, or is not a near-future event.
export function noteSpan(text, now = new Date()) {
  const dates = explicitDates(text, now);
  if (!dates.length) return null;
  if (PAST_CUE.test(String(text))) return null;
  const today = utcDay(new Date(now));
  const first = dates[0], last = dates[dates.length - 1];
  if (last.ms < today) return null;                                   // all in the past
  if (!first.hasYear && first.ms - today > HORIZON_DAYS * dayMs) return null; // far, ambiguous year
  return { start: first.ms, end: last.ms, startDay: first.day, endDay: last.day };
}

// The expiry a dated note should carry: noon UTC the day after its last date.
export function expiryFromText(text, now = new Date()) {
  const span = noteSpan(text, now);
  return span ? new Date(span.end + dayMs + 12 * 3600000).toISOString() : null;
}

// "44 days out" / "starts tomorrow" / "on now, ends in 3 days" / "today".
// Computed here so Joe and the tab never do date arithmetic.
export function countdownLine(text, now = new Date()) {
  const span = noteSpan(text, now);
  if (!span) return null;
  const today = utcDay(new Date(now));
  const toStart = Math.round((span.start - today) / dayMs);
  const toEnd = Math.round((span.end - today) / dayMs);
  const plural = (n) => `${n} day${n === 1 ? "" : "s"}`;
  if (toStart > 1) return `${plural(toStart)} out`;
  if (toStart === 1) return "tomorrow";
  if (toStart === 0 && toEnd === 0) return "today";
  if (toStart === 0) return `starts today, ends in ${plural(toEnd)}`;
  if (toEnd === 0) return "ends today";
  return `on now, ends in ${plural(toEnd)}`;
}

// A note is a dated event (Schedule, never asked) when it carries a span.
export const isDatedEvent = (row, now = new Date()) => !!row && (!!noteSpan(row.content, now) || (!!row.expires_at && !/^\s*Watching:/i.test(row.content || "") && row.kind !== "pinned" && Number.isFinite(Date.parse(row.expires_at))));

// What Joe reads for a dated note: the note with its countdown after it.
export const withCountdown = (content, now = new Date()) => {
  const c = countdownLine(content, now);
  return c ? `${content} (${c})` : content;
};
