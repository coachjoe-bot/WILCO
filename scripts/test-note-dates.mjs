// ─── DATED NOTES (T69-C) ─────────────────────────────────────────────────────
// Will 10-01: "A note with a clear date in it drops when the date passes,
// without asking." Replay: his 08-09 goal row said "... will set new bench
// target after maxing out tomorrow ..." and lived on his tab for seven weeks.
// A note with a relative time word cannot be saved without an expiry; a note
// with a calendar date gets that date as its expiry; Joe is handed a countdown
// computed in code.
import { relativeTimeWord, needsDate, explicitDates, noteSpan, expiryFromText, countdownLine, withCountdown, isDatedEvent, NEEDS_DATE } from "../src/noteDates.js";
import { validateFact } from "../src/memory.js";

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } };

const NOW = new Date("2026-10-03T14:00:00Z");
const day = 864e5;
const plus = (n) => new Date(NOW.getTime() + n * day).toISOString();

console.log("relative time words:");
for (const t of [
  "Bench 315 goal pushed back past mid-August; will set new bench target after maxing out tomorrow",
  "Maxing out tomorrow", "Travelling next week", "Deload this block", "Away until Thursday", "Back after Friday",
  "On a cruise in two weeks", "Exam tonight", "Sick last week", "Heavy day this weekend", "Busy this month",
  "Lifts at the gym by Monday", "Leaves in 3 days",
]) ok(!!relativeTimeWord(t), `relative: ${t}`);
for (const t of [
  "Trains Monday, Wednesday and Friday", "Prefers kg on the barbell lifts", "Sleeps 8 hours", "Full gym access",
  "Works nights", "Trains 6 to 7am on class days", "Squat PR 405 lb", "Rehabbing inflamed knees, strengthening weak core and low back",
  "Competes in the 73 kg class", "Does 5/3/1 on bench",
]) ok(!relativeTimeWord(t), `not relative: ${t}`);

console.log("needsDate (the save gate):");
ok(needsDate("Maxing out tomorrow", null, NOW) === "needs_date", "relative + no expiry refused");
ok(needsDate("Maxing out tomorrow", plus(2), NOW) === null, "relative + a future expiry is fine");
ok(needsDate("Maxing out tomorrow", plus(-1), NOW) === "needs_date", "relative + a PAST expiry still refused");
ok(needsDate("Watching: bench press (pain) reported this week", null, NOW) === null, "app-written Watching notes are exempt");
ok(needsDate("Prefers kg on the barbell lifts", null, NOW) === null, "plain note untouched");

console.log("validateFact applies it everywhere (the one validator):");
const a = validateFact({ content: "Maxing out tomorrow, bench target after", kind: "contextual", expires_at: null });
ok(!a.ok && a.reason === "needs_date", "contextual 'tomorrow' note refused with needs_date");
ok(a.toolResult === NEEDS_DATE, "refusal carries the sentence Joe and the athlete read");
ok(validateFact({ content: "Maxing out on Oct 4", kind: "situational", expires_at: plus(2) }).ok, "dated + expiry saves");
ok(validateFact({ content: "Away next week", kind: "situational", expires_at: plus(8) }).ok, "situational with expiry saves");
ok(!validateFact({ content: "Away next week", kind: "pinned", expires_at: null }).ok, "pinned relative note refused (pinned never expires)");
ok(validateFact({ content: "Prefers kg", kind: "pinned" }).ok, "pinned plain note unaffected");

console.log("explicit dates:");
let d = explicitDates("Meet Nov 14, 73 kg class", NOW).map((x) => x.day);
ok(d.length === 1 && d[0] === "2026-11-14", "Nov 14 resolves to this year");
d = explicitDates("Exam week Oct 26 to 30", NOW).map((x) => x.day);
ok(d.join() === "2026-10-26,2026-10-30", "a range ends on its second day");
d = explicitDates("Trip Dec 20-27", NOW).map((x) => x.day);
ok(d.join() === "2026-12-20,2026-12-27", "hyphen range");
d = explicitDates("Competition on 2026-11-02", NOW).map((x) => x.day);
ok(d[0] === "2026-11-02", "ISO date");
d = explicitDates("Meet January 9", NOW).map((x) => x.day);
ok(d[0] === "2027-01-09", "a month already behind rolls to next year");
d = explicitDates("Sept 12th", NOW).map((x) => x.day);
ok(d[0] === "2027-09-12", "Sept 12th is parsed (rolled, it is past this year)");
ok(explicitDates("Feb 31", NOW).length === 0, "impossible date ignored");
ok(explicitDates("May squat day heavy", NOW).length === 0, "'May' without a day is not a date");

console.log("expiry from the text:");
ok(expiryFromText("Meet Nov 14, 73 kg class", NOW) === "2026-11-15T12:00:00.000Z", "expires noon UTC the day after");
ok(expiryFromText("Exam week Oct 26 to 30", NOW) === "2026-10-31T12:00:00.000Z", "a range expires after its LAST day");
ok(expiryFromText("Prefers kg", NOW) === null, "no date, no expiry");
ok(expiryFromText("Started lifting Mar 3", NOW) === null, "a past-tense note is history and never auto-expires");
ok(expiryFromText("Hit 300 on Aug 3", NOW) === null, "an old PR date is history");
ok(expiryFromText("Competed Jan 5, 2025", NOW) === null, "an explicit past year is history");
ok(expiryFromText("Meet Apr 20", NOW) === null, "a year-less date past the 180-day horizon is left alone (ambiguous year)");
ok(expiryFromText("Meet on Oct 3", NOW) === "2026-10-04T12:00:00.000Z", "today counts");
ok(expiryFromText("Meet on Oct 2", NOW) === null || explicitDates("Meet on Oct 2", NOW)[0].day === "2027-10-02", "yesterday year-less does not make a one-day note");

console.log("countdown (Joe never does the arithmetic):");
ok(countdownLine("Meet Nov 14, 73 kg class", NOW) === "42 days out", "42 days to Nov 14 from Oct 3");
ok(countdownLine("Meet Oct 4", NOW) === "tomorrow", "tomorrow");
ok(countdownLine("Meet Oct 3", NOW) === "today", "today");
ok(countdownLine("Exam week Oct 26 to 30", NOW) === "23 days out", "a range counts to its start");
ok(countdownLine("Exam week Oct 1 to 5", NOW) === "on now, ends in 2 days", "inside a range");
ok(countdownLine("Prefers kg", NOW) === null, "no date, no line");
ok(withCountdown("Meet Nov 14, 73 kg class", NOW) === "Meet Nov 14, 73 kg class (42 days out)", "the line Joe reads");
ok(withCountdown("Prefers kg", NOW) === "Prefers kg", "plain note unchanged");

console.log("dated events (Schedule, never asked):");
ok(isDatedEvent({ content: "Meet Nov 14", kind: "contextual", expires_at: null }, NOW), "a calendar date makes it an event");
ok(isDatedEvent({ content: "Away for a bit", kind: "situational", expires_at: plus(6) }, NOW), "an expiry makes it an event");
ok(!isDatedEvent({ content: "Prefers kg", kind: "pinned", expires_at: null }, NOW), "a plain note is not");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
