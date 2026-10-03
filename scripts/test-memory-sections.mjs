// ─── MEMORY SECTIONS (T69-C) ─────────────────────────────────────────────────
// Six sections on the tab (Bio, Goal, Schedule, Body, Preferences, This week);
// a stored note lives in one of four. A row from before this shipped has no
// section, and code gives it one at read time. The retired check-in summaries
// stay out of sight, and the check-in writes ONE This-week row.
import { resolveSection, isLegacyCheckinNote, isWatchNote, isHiddenRow, visibleRows, groupBySection, recentlyRemoved, thisWeekFact, recoveryStrip, NOTE_SECTIONS, THIS_WEEK_DAYS } from "../src/memorySections.js";
import { validateFact, activeFacts, buildMemoryBlock, memoryNotesText } from "../src/memory.js";

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } };

const NOW = new Date("2026-10-03T14:00:00Z");
const day = 864e5;
const iso = (n) => new Date(NOW.getTime() + n * day).toISOString();
const row = (content, over = {}) => ({ id: over.id || content.slice(0, 8), content, kind: "contextual", status: "active", source: "athlete_said", expires_at: null, created_at: iso(-30), updated_at: iso(-30), ...over });

console.log("resolveSection (legacy rows get a section from code):");
const cases = [
  ["Prefers kg on the barbell lifts", "preferences"],
  ["Prefers lbs on bench press and dumbbells", "preferences"],
  ["No RPE. Percentages only.", "preferences"],
  ["Keep it blunt. Skip the pep talk.", "preferences"],
  ["Sessions capped at 75 minutes", "preferences"],
  ["Trains 6 to 7am on class days", "schedule"],
  ["Full gym access at school", "schedule"],
  ["Meet Nov 14, 73 kg class", "schedule"],
  ["Exam week Oct 26 to 30", "schedule"],
  ["Back to 6 days a week from Monday", "schedule"],
  ["Rehabbing inflamed knees, strengthening weak core and low back", "body"],
  ["Torn labrum surgery in 2023, no overhead pressing past 70 lb", "body"],
  ["Left pec: hit new est. PR on incline DB bench (75 lb top set)", "body"],
  ["Front Squat, Snatch Pull and other main lift loads logged Sep 1 were in kg", "preferences"],
  ["Something Joe should know that fits nowhere", "preferences"],
];
for (const [text, want] of cases) ok(resolveSection(row(text), NOW) === want, `${want}: ${text}`);
ok(resolveSection(row("Watching: bench press (pain) reported 2026-09-21", { kind: "situational", expires_at: iso(2) }), NOW) === "this_week", "a Watching note is This week");
ok(resolveSection(row("Prefers kg", { section: "schedule" }), NOW) === "schedule", "a stored section always wins");
ok(resolveSection(row("Prefers kg", { section: "nonsense" }), NOW) === "preferences", "a stored value outside the vocabulary is ignored");
ok(resolveSection(row("Away for a bit", { kind: "situational", expires_at: iso(6) }), NOW) === "schedule", "an expiring note is a dated thing, Schedule");
ok(NOTE_SECTIONS.join() === "schedule,body,preferences,this_week", "the stored vocabulary (the DB CHECK and the gateway guard list the same four)");

console.log("hidden rows (the retired check-in summaries):");
const summary = row("Weekly check-in Sep 21: Bodyweight stable at 165 lbs. Short on time.", { kind: "situational", source: "inferred", expires_at: iso(60) });
const monthly = row("Monthly check-in Sep 6: Recovery flat this week.", { kind: "situational", expires_at: iso(60) });
ok(isLegacyCheckinNote(summary) && isLegacyCheckinNote(monthly), "a sectionless 'Weekly/Monthly check-in' row is a legacy summary");
ok(isHiddenRow(summary), "and it is hidden");
ok(!isLegacyCheckinNote({ ...summary, section: "this_week" }), "a row the NEW check-in wrote has a section and is never mistaken for one");
ok(!isHiddenRow(row("Prefers kg")), "ordinary notes are visible");
ok(isWatchNote(row("Watching: x")), "watch note detected");
const all = [summary, monthly, row("Prefers kg"), row("Meet Nov 14")];
ok(visibleRows(all, NOW).length === 2, "visibleRows drops both summaries");
const g = groupBySection(all, NOW);
ok(g.preferences.length === 1 && g.schedule.length === 1 && g.body.length === 0 && g.this_week.length === 0, "grouped by section");

console.log("Joe's block: grouped by section, hidden rows dropped, countdown computed:");
const block = buildMemoryBlock([summary, row("Prefers kg on the barbell lifts", { kind: "pinned" }), row("Meet Nov 14, 73 kg class", { kind: "situational", expires_at: iso(43) }), row("Rehabbing inflamed knees"), row("Check-in Oct 2. Recovery: dialed.", { section: "this_week", kind: "situational", expires_at: iso(26) })], NOW);
ok(!/Weekly check-in/.test(block), "the old summary never reaches Joe");
ok(/Schedule:/.test(block) && /Body:/.test(block) && /Preferences:/.test(block) && /This week:/.test(block), "section headings in order");
ok(block.indexOf("Schedule:") < block.indexOf("Body:") && block.indexOf("Body:") < block.indexOf("Preferences:") && block.indexOf("Preferences:") < block.indexOf("This week:"), "Schedule, Body, Preferences, This week");
ok(/Meet Nov 14, 73 kg class \(42 days out\)/.test(block), "the event line carries the countdown (Joe never does the arithmetic)");
ok(/\[pinned\] Prefers kg/.test(block), "a pinned line keeps its tag");
ok(!/Weekly check-in/.test(memoryNotesText([summary, row("Prefers kg")], NOW)), "every other prompt drops the summaries too");

console.log("Recently removed (30 days):");
const del = (c, n) => row(c, { status: "deleted", updated_at: iso(n) });
const rr = recentlyRemoved([del("Prefers kg", -3), del("Old note", -45), del("Weekly check-in Sep 1: x", -2), del("Watching: x", -2), row("Active note")], NOW);
ok(rr.length === 1 && rr[0].content === "Prefers kg", "only deleted notes from the last 30 days, no summaries, no watch notes");

console.log("This-week row (one per check-in):");
const tw = thisWeekFact({ recovery: "dialed", note: "school ate the week, back to 6 from Monday" }, NOW);
ok(tw.section === "this_week" && tw.kind === "situational", "section this_week, situational");
ok(Date.parse(tw.expires_at) - NOW.getTime() === THIS_WEEK_DAYS * day, "expires in 28 days");
ok(/^Check-in Oct 3\. Recovery: dialed\. School ate the week, back to 6 from Monday\.$/.test(tw.content), "content reads as one plain row");
ok(validateFact(tw).ok, "it passes the one validator");
ok(thisWeekFact({ recovery: "flat" }, NOW).content === "Check-in Oct 3. Recovery: flat.", "recovery only");
ok(thisWeekFact({ note: "traveling for work" }, NOW).content === "Check-in Oct 3. Traveling for work.", "note only");
ok(thisWeekFact({}, NOW) === null && thisWeekFact({ recovery: "  ", note: "." }, NOW) === null, "nothing to say, no row");
ok(validateFact(thisWeekFact({ recovery: "dialed", note: "away until next week" }, NOW)).ok, "a relative word is fine here: the row carries its own expiry");

console.log("recovery strip (the last four check-ins):");
const wk = (label, word, ago) => row(`Check-in ${label}. Recovery: ${word}.`, { section: "this_week", kind: "situational", created_at: iso(-ago), updated_at: iso(-ago), expires_at: iso(28 - ago) });
const strip = recoveryStrip([wk("Sep 7", "flat", 26), wk("Sep 14", "sick", 19), wk("Sep 21", "dialed", 12), wk("Sep 28", "dialed", 5), wk("Aug 31", "fumes", 33)], NOW);
ok(strip.length === 3 || strip.length === 4, "only the unexpired ones");
ok(strip.map((s) => s.label).join() === "Sep 14,Sep 21,Sep 28" || strip.map((s) => s.label).join() === "Sep 7,Sep 14,Sep 21,Sep 28", `oldest to newest (${strip.map((s) => s.label)})`);
ok(strip[strip.length - 1].now === true && strip.slice(0, -1).every((s) => !s.now), "the latest is marked now");
ok(strip[strip.length - 1].word === "dialed", "the word is the athlete's");
ok(recoveryStrip([row("Watching: x", { section: "this_week" }), row("Check-in Oct 1.", { section: "this_week" })], NOW).length === 0, "a row with no recovery word is not on the strip");
ok(recoveryStrip([], NOW).length === 0, "empty is empty");

console.log("activeFacts + expiry still do the dropping:");
ok(activeFacts([row("Exam Oct 1", { expires_at: iso(-2) })], NOW).length === 0, "a dated note drops after its date, no asking");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
