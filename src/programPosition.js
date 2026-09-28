// ─── WHERE THE ATHLETE IS IN THEIR PROGRAM ───────────────────────────────────
// Replaces the guess that shipped before this: anchor on the last logged session's
// typed day label, then advance by `round(daysSince * training_days_per_week / 7)`
// and let the model walk the free-text program forward that many sessions, wrapping
// weeks itself.
//
// That formula assumes training days are spread evenly across the week. On any
// program under 7 days/week they never are — athletes start on different weekdays and
// move their rest days — so it drifted constantly, and every correction the athlete
// typed was thrown away because nothing stored the answer. (Will, 2026-07-27.)
//
// THE RULE NOW (Will's call):
//   • WEEK is calendar. It turns over every SUNDAY, to the first workout of the next
//     week of the program. Anything programmed for last week and not logged was
//     missed — the program moves on without it.
//   • DAY WITHIN THE WEEK is sequence. Log a session, you're on the next day. Rest
//     days are simply days with no log; they don't advance anything and don't need to
//     be modelled.
//   • The athlete outranks both. "I'm on day 2" makes day 2 the truth, and the next
//     session is day 3.
//
// Both numbers are DERIVED, never stored as a mutable counter — a counter drifts the
// moment a write is missed, and it can't be recomputed after the fact. Week comes from
// the calendar; day comes from counting the sessions logged since Sunday. The only
// persisted state is where the program started and any override the athlete stated.
// Nothing to keep in sync, nothing a failed job can corrupt, and it self-heals.

// ─── PROGRAM SHAPE ───────────────────────────────────────────────────────────
// Real programs land in three layouts, and position means the same thing in all of
// them, so the parser reduces all three to ONE weekly template plus a week count:
//   A. Week-sectioned — "Week 1 / Day 1 … Day 2 … Week 2 / Day 1 …"
//   B. Day list with per-week load columns — "Day 1 – Push: Bench 3x5 (Wk1 65%, Wk2 70%)"
//   C. Plain day list, no weeks at all.
// The weekly TEMPLATE (the ordered day labels of one week) is what day-within-week
// indexes into; the week number selects which week's loads to read. For B and C the
// template is just the day list.

const WEEK_HEADER_RE = /^\s*#{0,3}\s*(?:block\s+[^,\n]{1,20}[,\s]+)?(?:week|wk)\s*#?\s*(\d{1,2})\b/i;

// "Week 3 of 12", "Wk 5 of 8". One phrase that states two DIFFERENT things: which week
// the athlete is on (N) and how long the block runs (M). Only M is a length.
//
// This is the whole reason the two regexes below exist. Read plainly, "Week 3 of 12"
// looks like every other week mention, so the highest-number-wins scan took 3 as the
// block length, ignored the "of 12" entirely, and reported a finished three-week block
// to someone with nine weeks left — the exact false "your block is over" that the rest
// of this file was written to prevent, delivered with full confidence.
//
// The trailing lookahead keeps "3 sets of 5 reps" style prose out of it.
const OF_TAIL = String.raw`\s+of\s+(\d{1,2})\b(?!\s*(?:sets?|reps?|rounds?)\b)`;
const WEEK_OF_RE = new RegExp(String.raw`\b(?:week|wk)\s*#?\s*(\d{1,2})` + OF_TAIL, "i");
// Every week mention in the text, with its "of M" tail captured when it has one.
const WEEK_MENTION_RE = new RegExp(String.raw`\b(?:wk|week)\s*#?\s*(\d{1,2})(?:` + OF_TAIL + `)?`, "gi");

// Day headers come in two strengths, and the distinction is load-bearing. Will's own
// program is laid out as:
//     MONDAY — PUSH A          <- the day
//     BENCH — PYRAMID          <- a SECTION inside that day
//     Bench Press — 5 sets climbing: 67% / 72% …
//     OVERHEAD                 <- another section
// A single flat matcher that accepts "bench"/"squat"/"push" reads those section
// headers as days, inflating a 6-day week into fifteen and shifting every subsequent
// day — which is precisely the silent mis-prescription this module exists to stop.
//
// So: STRONG headers (a weekday name, or "Day 3") are unambiguous — they can only be
// a session. If a program uses any, they alone define the week. WEAK headers
// ("Push A", "Upper", "Legs") are only consulted when there are no strong ones,
// because in that layout they ARE the days.
const STRONG_DAY_RE = /^\s*#{0,3}\s*(?:(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|weds?|thur?s?|fri|sat|sun)\b|day\s*#?\s*(\d{1,2})\b)/i;
const WEAK_DAY_RE = /^\s*#{0,3}\s*(?:upper|lower|push|pull|full[\s-]?body|legs?|chest|back|arms|shoulders|conditioning)\b/i;

// Anything prescribing work is an exercise line, never a header. Covers "4×5-6",
// "5x3", "3 sets of 8" and "5 sets climbing" — the last of which has no digit-x-digit
// at all, which is how "Bench Press — 5 sets climbing: 67%" slipped through as a day.
const SETS_REPS_RE = /\d+\s*(?:x|×)\s*\d+|\b\d+\s*sets?\b|@\s*\d|\d\s*%/i;

const WEEKDAY_KEY = { mon:1, monday:1, tue:2, tues:2, tuesday:2, wed:3, weds:3, wednesday:3, thu:4, thur:4, thurs:4, thursday:4, fri:5, friday:5, sat:6, saturday:6, sun:0, sunday:0 };

const cleanLabel = (line) =>
  String(line).trim().replace(/^#+\s*/, "").replace(/[:\-–—\s]+$/, "").slice(0, 80);

// Ordered day labels of ONE week, plus how many weeks the program covers.
export const parseProgramShape = (programText) => {
  const lines = String(programText || "").split("\n");
  const weeks = new Set();
  // ONE ordered list of distinct days, deduped by IDENTITY rather than by text. That
  // makes the week-sectioned layout collapse for free — Week 1's "Day 1/2/3" and Week
  // 2's are the same three days — so there's no need to guess which week's block is
  // the "real" template. It also survives a multi-block program repeating its weekdays
  // with drifting wording ("WEDNESDAY — OLY + LEGS (moderate)" in one block,
  // "WEDNESDAY — OLY + LEGS" in the next): keyed on the weekday those are one day,
  // keyed on the string they'd be two, and a phantom day shifts everything after it.
  const days = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const wm = t.match(WEEK_HEADER_RE);
    if (wm) {
      // A WEEK SECTION header is a line that declares one week and stops. A load
      // column ("Wk1 top set: 88% | Wk2: 89% | Wk3: 91%") also starts with a week
      // token but names several — counting them apart keeps a progression note from
      // being read as the start of a new section.
      const mentions = (t.match(/\b(?:wk|week)\s*#?\s*\d{1,2}\b/gi) || []).length;
      const n = parseInt(wm[1], 10);
      // "Week 3 of 12" is a POSITION, not one of an enumerated set — it says nothing
      // about how many week sections this program contains, so its N must never join
      // them. Its M is a length and is picked up by the whole-text scan below.
      if (WEEK_OF_RE.test(t)) continue;
      if (mentions === 1 && n >= 1 && n <= 52) { weeks.add(n); continue; }
    }
    if (SETS_REPS_RE.test(t)) continue;                 // an exercise line, never a header
    const strong = t.match(STRONG_DAY_RE);
    if (!strong && !WEAK_DAY_RE.test(t)) continue;
    const key = strong
      ? (strong[1] ? `wd:${WEEKDAY_KEY[strong[1].toLowerCase()]}` : `dn:${parseInt(strong[2], 10)}`)
      : `wk:${cleanLabel(t).toLowerCase()}`;
    if (!days.some((e) => e.key === key)) days.push({ key, label: cleanLabel(t), strong: !!strong });
  }
  // Strong headers win outright when the program has any: the weak matches alongside
  // them are section headings inside a day ("BENCH — PYRAMID" under "MONDAY — PUSH A"),
  // not days of their own.
  const strongOnly = days.filter((e) => e.strong);
  const template = (strongOnly.length ? strongOnly : days).map((e) => e.label);
  // Layout B declares its length INLINE rather than in headers — the days are written
  // once and the loads carry a column per week ("Bench 3x5 (Wk1 65%, Wk2 70%, Wk3
  // 75%)"). Without this a 4-week block reports zero weeks, so nothing would tell the
  // draft which column to read and the block could never register as finished.
  // Numbered week SECTIONS only measure the block when there are at least two of them
  // to enumerate it. One header on its own — "Week 3", the header a coach writes on the
  // week they hand the program over — states where the athlete is, not how long the
  // program runs, and taking its number as the length ends the block the moment they
  // reach it. Was: any single header set the count unless it happened to say "week 1".
  let weekCount = weeks.size >= 2 ? Math.max(...weeks) : 0;
  // Layouts that declare their length INLINE rather than in headers also count —
  // a "Wk1 / Wk2 / Wk3 / Wk4" progression line says the block is four weeks just as
  // clearly as four section headers would. Taken as the max across the whole text so
  // it works whether the weeks are sections, columns, or both.
  const inline = new Set();
  // …and "Week 3 of 12" declares the length outright. It's the most explicit statement
  // a program can make about its own span, so it outranks anything counted.
  let declaredMax = 0;
  for (const m of String(programText || "").matchAll(WEEK_MENTION_RE)) {
    const of = m[2] ? parseInt(m[2], 10) : 0;
    if (of >= 1 && of <= 52) { if (of > declaredMax) declaredMax = of; continue; }
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 52) inline.add(n);
  }
  // A single stray week mention is a sentence, not a structure — two or more DISTINCT
  // week numbers is a real block length. Distinct, not merely a high one: "Week 3" on
  // its own is where the athlete is, and reading it as a three-week program ends their
  // block the week they arrive at it. (This is what the line has always claimed to do;
  // it tested the highest number instead of how many there were.)
  const inlineMax = inline.size >= 2 ? Math.max(...inline) : 0;
  if (inlineMax > weekCount) weekCount = inlineMax;
  if (declaredMax > weekCount) weekCount = declaredMax;
  return {
    dayTemplate: template,
    weekCount,
    hasWeeks: weekCount > 0,
  };
};

// ─── CALENDAR ────────────────────────────────────────────────────────────────
// LOCAL dates throughout, never UTC. A UTC day boundary rolls over mid-evening, which
// would turn the week early for anyone west of Greenwich — the same class of bug that
// has already bitten the Quick Log day stamp and the demo's week cache.

// Midnight local on the Sunday on or before `d`. Sunday is day 0, so this is simply
// "back up to the start of this calendar week".
export const sundayOnOrBefore = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
};

// How many Sunday boundaries fall in (from, to]. This is the number of times the
// program week has turned over — NOT elapsed days / 7, which would be wrong whenever
// the start date isn't itself a Sunday.
export const weeksTurnedOver = (from, to) => {
  const a = sundayOnOrBefore(from), b = sundayOnOrBefore(to);
  if (b <= a) return 0;
  return Math.round((b - a) / (7 * 24 * 60 * 60 * 1000));
};

// ─── POSITION ────────────────────────────────────────────────────────────────
// `sessions` = timestamps (ms or Date) of REAL logged sessions, any order. Callers
// pass one per session, not one per workout row — the caller groups first.
//
// `override` = {week, day, at} — the athlete stating where they are ("I'm on day 2").
// It wins over the derived day for the rest of that calendar week; the Sunday rule
// still turns the week, because the athlete telling us their day is not a statement
// that the program should stop advancing.
export const currentPosition = ({ programText, startedOn, override, sessions, now } = {}) => {
  const t = now ? new Date(now) : new Date();
  const shape = parseProgramShape(programText);
  const dayCount = shape.dayTemplate.length;
  const weekStart = sundayOnOrBefore(t);

  // ── WEEK ──
  // Only claimed when we can actually derive it — from the athlete's own statement, or
  // from when the program became active. With neither, `weekKnown` is false and the
  // caller must NOT assert a week: defaulting silently to "Week 1" is how an athlete
  // three weeks into a block gets shown week 1's loads with total confidence, which is
  // the failure this module exists to end. The DAY is still solid either way — it comes
  // from sessions logged since Sunday, which needs no anchor.
  let week = 1;
  let weekKnown = false;
  if (override?.week && override?.at) {
    week = override.week + weeksTurnedOver(override.at, t);
    weekKnown = true;
  } else if (startedOn) {
    week = 1 + weeksTurnedOver(startedOn, t);
    weekKnown = true;
  }
  week = Math.max(1, week);
  // A program that has run out of weeks holds on its last one rather than inventing
  // a Week 9 of an 8-week block. `blockComplete` is the honest signal to act on.
  const blockComplete = weekKnown && shape.weekCount > 0 && week > shape.weekCount;
  // Keep the pre-clamp number: `week` holds at the block's last week so nothing
  // displays "Week 6 of 4", but the week-ahead check needs to know by HOW MUCH they've
  // run past the end. Clamping both would make an athlete two weeks beyond their block
  // look like one still sitting in its final week.
  const weekRaw = week;
  if (blockComplete) week = shape.weekCount;

  // ── DAY WITHIN THE WEEK ──
  const times = (sessions || [])
    .map((s) => new Date(s).getTime())
    .filter((n) => Number.isFinite(n));
  const sinceWeekStart = times.filter((n) => n >= weekStart.getTime()).length;

  let day;
  const overrideAt = override?.at ? new Date(override.at) : null;
  const overrideThisWeek = overrideAt && overrideAt.getTime() >= weekStart.getTime();
  if (override?.day && overrideThisWeek) {
    // They named their day, then logged N sessions since saying so → day + N.
    const after = times.filter((n) => n > overrideAt.getTime()).length;
    day = override.day + after;
  } else {
    // Sunday reset: the first session of a new calendar week is day 1, whatever
    // happened last week and whatever was left unlogged in it.
    day = sinceWeekStart + 1;
  }
  // Logging more sessions than the week has days holds at the last one rather than
  // running off the end — the week turns on Sunday, not on session count.
  if (dayCount > 0) day = Math.min(Math.max(1, day), dayCount);
  else day = Math.max(1, day);

  // Sessions programmed for LAST week that never got logged. Will's rule is that the
  // program moves on regardless, so this is reported, never acted on — it's what the
  // week-ahead recap and the coach's brief need in order to say something true.
  const prevStart = new Date(weekStart); prevStart.setDate(prevStart.getDate() - 7);
  const loggedLastWeek = times.filter((n) => n >= prevStart.getTime() && n < weekStart.getTime()).length;
  const missedLastWeek = dayCount > 0 ? Math.max(0, dayCount - loggedLastWeek) : 0;

  const label = dayCount > 0 ? (shape.dayTemplate[day - 1] || "") : "";
  // Only sliced when the week isn't in question — with weekKnown false there is
  // no way to tell WHICH week's occurrence of this day label to grab in a
  // week-sectioned program, and a wrong guess there is worse than no hint at all.
  const sessionText = label && (!shape.hasWeeks || weekKnown)
    ? extractDaySessionText(programText, { week: shape.hasWeeks ? week : null, dayLabel: label })
    : null;

  return {
    week,
    weekRaw,
    weekKnown,
    day,
    label,
    sessionText,
    isRestDay: label ? isRestDayLabel(label) : false,
    dayTemplate: shape.dayTemplate,
    hasWeeks: shape.hasWeeks,
    weekCount: shape.weekCount,
    blockComplete,
    loggedThisWeek: sinceWeekStart,
    loggedLastWeek,
    missedLastWeek,
    weekStart,
  };
};

// ─── DOES THIS BLOCK END, AND WHEN? ──────────────────────────────────────────
// The dangerous mistake here runs in ONE direction. An athlete on a simple repeatable
// week — push/pull/legs, same every week, forever — has a program with no end. Read
// that as a one-week block and every single digest tells them their block is finished
// and asks if they want a new one. That is worse than saying nothing (Will,
// 2026-07-27), so nothing is what we say until we actually know.
//
// Knowing means one of:
//   • The athlete (or the Builder) told us: a planned end date, a length, or "it just
//     repeats". program_history.ends_at is the authoritative store — the column the
//     date-driven boundary work already put there.
//   • The program itself makes it unambiguous: it says how long it runs, or it visibly
//     changes week to week with numbered weeks. Then we can assume.
// Anything else is UNKNOWN, and unknown means ASK — in chat when the program lands,
// and in every Proof Feed until it's answered — while the week-ahead section stays off.

const REPEATING_RE = /\b(?:repeat(?:s|ing|ed)?\s+(?:weekly|each week|every week|indefinitely)?|run\s+(?:this\s+)?(?:weekly|on\s+repeat)|ongoing|indefinite(?:ly)?|no\s+end\s+date|until\s+further\s+notice|same\s+every\s+week|weekly\s+rotation)\b/i;
// "Duration: 4 Weeks", "4-week block", "6 week cycle", "over 8 weeks".
const DURATION_RE = /(?:duration\s*[:—-]?\s*(\d{1,2})\s*weeks?)|(\d{1,2})\s*[-–\s]\s*week\s+(?:block|program|cycle|phase|wave)|(?:over|across)\s+(\d{1,2})\s+weeks?/i;

// The BLOCK INFO contract's own dates ("Runs: 2026-08-17 to 2026-09-13") — the
// drafter states the block's span outright, so a contract program is never
// unknown and must never be asked about (T57). A single date reads as the END,
// mirroring parseTimeline.
const RUNS_RE = /^\s*Runs\s*:\s*.*?(\d{4}-\d{2}-\d{2})(?:\s*(?:to|through|–|—|-)\s*(\d{4}-\d{2}-\d{2}))?/im;

export const parseBlockSpan = (programText) => {
  const text = String(programText || "");
  if (!text.trim()) return { known: false, repeating: false, weeks: null, source: "none" };
  const runs = text.match(RUNS_RE);
  if (runs) return { known: true, repeating: false, weeks: null, endDate: runs[2] || runs[1], source: "text_runs" };
  // A Runs line WITHOUT ISO dates (the drafter drifted into prose: "Runs: Week 1
  // start (today) through Oct 10 (6 weeks)") still states the span — read the
  // week count off that line so a contract program is never asked when it ends
  // (T57 s5 live find). Scoped to the Runs line only: a bare "N weeks" anywhere
  // else in a program is not a span claim.
  const runsLine = text.match(/^\s*Runs\s*:\s*(.+)$/im);
  if (runsLine) {
    const wk = runsLine[1].match(/(\d{1,2})\s*(?:-|–|\s)\s*weeks?\b/i);
    const n = wk ? parseInt(wk[1], 10) : null;
    if (n && n >= 1 && n <= 52) return { known: true, repeating: false, weeks: n, source: "text_runs_weeks" };
  }
  // An explicit "this repeats" beats a week count — a 4-week wave the athlete runs on
  // loop is repeating, and treating it as finite would end it every fourth week.
  if (REPEATING_RE.test(text)) return { known: true, repeating: true, weeks: null, source: "text_repeating" };
  const d = text.match(DURATION_RE);
  // "Week 3 of 12" states the length as plainly as "Duration: 12 weeks" does, so it's
  // answered here rather than left to the counted-weeks fallback below — which reads
  // the 3 and would call the block finished with nine weeks still to run.
  const of = text.match(WEEK_OF_RE);
  const stated = d ? parseInt(d[1] || d[2] || d[3], 10) : (of ? parseInt(of[2], 10) : null);
  if (stated && stated >= 1 && stated <= 52) return { known: true, repeating: false, weeks: stated, source: "text_duration" };
  // Numbered weeks that actually differ week to week — the program is visibly a block
  // and says how many weeks it runs. Two or more, because a lone "Week 1" is a label,
  // not a length.
  const shape = parseProgramShape(text);
  if (shape.weekCount >= 2) return { known: true, repeating: false, weeks: shape.weekCount, source: "text_weeks" };
  return { known: false, repeating: false, weeks: null, source: "none" };
};

// The answer that actually governs, cheapest-authority-last:
//   stated end date > stated length / "it repeats" > what the program text shows.
// `answer` is the athlete's recorded reply ({endsAt, weeks, repeating}); `endsAt` is
// program_history.ends_at. Either being present means someone TOLD us, which always
// beats what we guessed from the text.
export const resolveBlockSpan = ({ programText, endsAt, answer } = {}) => {
  if (endsAt) return { known: true, repeating: false, weeks: null, endsAt: new Date(endsAt), source: "ends_at" };
  if (answer) {
    if (answer.repeating) return { known: true, repeating: true, weeks: null, endsAt: null, source: "athlete_repeating" };
    if (answer.endsAt) return { known: true, repeating: false, weeks: null, endsAt: new Date(answer.endsAt), source: "athlete_date" };
    if (answer.weeks) return { known: true, repeating: false, weeks: answer.weeks, endsAt: null, source: "athlete_weeks" };
  }
  const parsed = parseBlockSpan(programText);
  return { ...parsed, endsAt: parsed.endDate ? new Date(`${parsed.endDate}T12:00:00Z`) : null };
};

// ─── TODAY'S SESSION TEXT, VERBATIM ──────────────────────────────────────────
// T64 Fix 7b: once the week/day is resolved correctly, chat still had to pick the
// right day's LINES out of the whole program text itself, turn by turn — and that
// second lookup is where "Tuesday's a rest day" (actually Monday's line) came
// from. This slices the day's own text straight out of the program instead, the
// same way the header-detection above already knows where one day ends and the
// next begins. Deliberately conservative: any ambiguity returns null rather than
// a confidently wrong slice — callers already have the full program text as a
// fallback, so a null here costs nothing but the extra hint.
const isWeekSectionHeader = (t) => {
  if (!WEEK_HEADER_RE.test(t) || WEEK_OF_RE.test(t)) return false;
  const mentions = (t.match(/\b(?:wk|week)\s*#?\s*\d{1,2}\b/gi) || []).length;
  return mentions === 1;
};

export function extractDaySessionText(programText, { week = null, dayLabel = null } = {}) {
  const text = String(programText || "");
  if (!text.trim() || !dayLabel) return null;
  const lines = text.split("\n");
  const strongAnywhere = lines.some((l) => {
    const t = l.trim();
    return t && !SETS_REPS_RE.test(t) && STRONG_DAY_RE.test(t);
  });
  const isDayHeaderLine = (t) => {
    if (SETS_REPS_RE.test(t)) return false;
    return strongAnywhere ? STRONG_DAY_RE.test(t) : WEAK_DAY_RE.test(t);
  };
  const target = cleanLabel(dayLabel).toLowerCase();

  let curWeek = null;
  let matchStart = -1;
  let matchEnd = lines.length;
  let matched = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (isWeekSectionHeader(t)) {
      if (matched) { matchEnd = i; break; }
      const m = t.match(WEEK_HEADER_RE);
      curWeek = m ? parseInt(m[1], 10) : curWeek;
      continue;
    }
    if (isDayHeaderLine(t)) {
      if (matched) { matchEnd = i; break; }
      const inRightWeek = week == null || curWeek == null || curWeek === week;
      if (inRightWeek && cleanLabel(t).toLowerCase() === target) {
        matchStart = i;
        matched = true;
      }
      continue;
    }
  }
  if (!matched || matchStart < 0) return null;
  const body = lines.slice(matchStart, matchEnd).join("\n").trim();
  return body || null;
}

// A day's own text reads as a rest day when its header line SAYS so ("MON —
// off", "Rest day") — never inferred from the absence of set×rep numbers, which
// a mobility/recovery session could also lack while still being real work.
const REST_LABEL_RE = /\b(rest|off)\b/i;
export function isRestDayLabel(label) {
  return REST_LABEL_RE.test(String(label || ""));
}

// ─── PROGRAM IDENTITY ────────────────────────────────────────────────────────
// A cheap, deterministic fingerprint of a program's CURRENT text — good enough to
// tell "this is a different program than a moment ago" without pulling in a real
// hash library. Used to key the chat context cache to the program itself rather
// than to a time-to-live, so a brand new program can never have a stale start
// date served from a cache that hasn't noticed anything changed (T64 Fix 7a).
export function programTextIdentity(text) {
  const s = String(text || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

// ─── THE WEEK AHEAD ──────────────────────────────────────────────────────────
// What the Proof Feed and the Coach's Edition look forward to. Two outcomes, and the
// difference matters more than the contents of either:
//   • There IS programming for the coming week → the sessions in it, so the digest can
//     highlight the top sets worth turning up for.
//   • There ISN'T — they've finished the last week of the block → say so, and open the
//     conversation about what comes next instead of inventing a week that doesn't exist.
//
// WHICH week is "ahead" depends on when the digest runs, which is per-athlete
// (proof_schedule_dow). Fire it ON Sunday and the week has already turned — the week
// ahead is the one that just started. Fire it on a Friday and it's the next one. Both
// are handled here rather than in the caller, because getting it wrong means previewing
// a week the athlete is already halfway through.
export const weekAheadFor = ({ programText, startedOn, override, sessions, now, endsAt, spanAnswer } = {}) => {
  const t = now ? new Date(now) : new Date();
  const pos = currentPosition({ programText, startedOn, override, sessions, now: t });
  if (!pos.dayTemplate.length) return null;

  const span = resolveBlockSpan({ programText, endsAt, answer: spanAnswer });

  // Sunday, with nothing logged yet → the week that just began IS the week ahead.
  const startedThisWeek = t.getDay() === 0 && pos.loggedThisWeek === 0;
  // From weekRaw, not the clamped week: someone two weeks past the end of their block
  // must still read as finished, and the clamp would present them as sitting in its
  // final week forever.
  const week = pos.weekRaw + (startedThisWeek ? 0 : 1);

  // ── What don't we know? ──
  // A repeating program needs no anchor: every week is the same week, so the sessions
  // ahead are simply the template. A FINITE block needs to know which week they're on,
  // or it can say neither what's coming nor whether the block is over.
  const needsSpan = !span.known;
  const needsWeek = span.known && !span.repeating && !pos.weekKnown;
  const ready = !needsSpan && !needsWeek;

  // End date beats week count when we have one — the decided direction for boundaries
  // is date-driven, and a date survives an athlete training more or less often than
  // the block assumed.
  const blockEnded = !ready ? false
    : span.repeating ? false
    : span.endsAt ? t.getTime() > span.endsAt.getTime()
    : span.weeks > 0 ? week > span.weeks
    : false;

  return {
    // Nothing to preview until both questions are answered. Callers render no section
    // at all in that case — an absent week-ahead beats a wrong one.
    ready,
    needsSpan,
    needsWeek,
    week: !ready || blockEnded ? null : week,
    weekKnown: pos.weekKnown,
    weekCount: span.weeks || pos.weekCount || null,
    repeating: !!span.repeating,
    spanSource: span.source,
    endsAt: span.endsAt ? span.endsAt.toISOString() : null,
    hasWeeks: pos.hasWeeks,
    blockEnded,
    // Next week runs the full template — the Sunday rule resets to day 1 regardless of
    // how much of last week got logged.
    days: pos.dayTemplate,
    missedLastWeek: pos.missedLastWeek,
  };
};

// The block handed to the draft/opener prompts. Stated flatly and without hedging:
// the whole point of this module is that the model no longer has to work position out
// for itself, so the prompt must not invite it to.
export const positionBlock = (pos) => {
  if (!pos || !pos.dayTemplate?.length) return "";
  const weekPrefix = pos.hasWeeks && pos.weekKnown ? `Week ${pos.week}, ` : "";
  const lines = [
    `- TODAY IS: ${weekPrefix}Day ${pos.day}${pos.label ? ` — "${pos.label}"` : ""}. This is RESOLVED — use it exactly. Do NOT re-derive the day from the calendar, from how long ago they last trained, or from the exercises in their history.`,
    `- The week runs Sunday to Saturday and turns over every Sunday to the next week of the program.${pos.hasWeeks && pos.weekCount ? ` This program covers ${pos.weekCount} week${pos.weekCount === 1 ? "" : "s"}.` : ""}`,
    `- Sessions logged since Sunday: ${pos.loggedThisWeek}. This week's session order: ${pos.dayTemplate.map((d, i) => `${i + 1}. ${d}`).join(" | ")}.`,
  ];
  if (pos.hasWeeks && pos.weekKnown) lines.push(`- Read every load, percentage and progression from the WEEK ${pos.week} column/section. Not week 1, unless week 1 is where they are.`);
  // Say so plainly rather than defaulting to week 1 and sounding certain. Asking once
  // costs a sentence; guessing wrong costs the athlete a session at the wrong loads.
  if (pos.hasWeeks && !pos.weekKnown) lines.push(`- WHICH WEEK of the program they're on is NOT known — nothing on record establishes it. Do NOT assume Week 1 and do NOT state a week as if it were fact. Use the loads you can justify from their recent logged sessions, and ask them once, plainly, which week they're on ("Which week of the block are you on?") so it can be recorded.`);
  if (pos.missedLastWeek > 0) lines.push(`- They missed ${pos.missedLastWeek} programmed session${pos.missedLastWeek === 1 ? "" : "s"} last week. The program has MOVED ON — do not try to make them up, and do not mention it unless they raise it.`);
  if (pos.blockComplete) lines.push(`- They have reached the END of this program's ${pos.weekCount} weeks and are holding on the final week. Worth telling them the block is done when it fits naturally.`);
  // T64 Fix 7b: hand over the day's OWN lines verbatim so the model reads them
  // instead of re-locating "today" inside the full program text itself — that
  // second, unresolved lookup is what let a reply about Tuesday quote Monday's
  // "off" line. When the slice couldn't be found confidently, say so plainly
  // rather than let silence read as permission to go hunt through the program.
  if (pos.isRestDay) {
    lines.push(`- TODAY IS A REST DAY per the program's own label ("${pos.label}"). Nothing is programmed. Do not invent a session for it.`);
  } else if (pos.sessionText) {
    lines.push(`- TODAY'S SESSION, EXACT TEXT FROM THE PROGRAM (this and only this — do not quote a different day's lines, even one mentioned earlier in this conversation):\n${pos.sessionText}`);
  } else {
    lines.push(`- Today's exact lines could not be sliced out of the program automatically — read them yourself from the day labeled "${pos.label}" in the ATHLETE'S CURRENT PROGRAM below, and only that day.`);
  }
  return lines.join("\n");
};
