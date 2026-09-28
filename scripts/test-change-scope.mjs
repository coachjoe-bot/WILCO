// changeScope regression suite — run with: node scripts/test-change-scope.mjs
// T64 Fix 4 (extended in S1c): does a described equipment/condition change
// span one training day or two-plus? Pure, deterministic, no network. Cases
// pulled from the T64 diagnosis (BUG 4), its gap hunters, the orchestrator's
// independent multi-day probe, and the S1c timezone-bug report.

import { changeScope } from "../src/changeScope.js";

let fail = 0;
const bad = (msg) => { fail++; console.error("  ✗ " + msg); };
const ok = (cond, msg) => { if (!cond) bad(msg); };

// Noon UTC: a stable point in the day so message-only cases (no `tz` passed)
// read the same calendar weekday under local getters on any real machine
// timezone. 2026-09-07 is a Monday.
const MON = new Date("2026-09-07T12:00:00Z");

console.log("changeScope — common paths:");
{
  // Will's REAL message (T64 diagnosis A, BUG 4).
  const r = changeScope({ message: "I don't have my weightlifting shoes with me so I can't really do snatch balance. I am thinking of doing behind the neck push press at a snatch grip and push press and then some other shoulder work in place of today's workout.", today: MON });
  ok(r.days === 1 && r.confidence === "high", "Will's real message: explicit 'today's workout' → 1 day, high confidence");
  ok(r.signal === "today_only", "Will's real message: signal is today_only");
}
{
  const r = changeScope({ message: "No gym today, hotel only, doing bodyweight instead", today: MON });
  ok(r.days === 1 && r.confidence === "high", "'no gym today' → 1 day, high confidence");
}
{
  const r = changeScope({ message: "I'm traveling for a week, only have dumbbells", today: MON });
  ok(r.days >= 2, "genuinely multi-day, plainly stated → 2+ days");
  ok(r.confidence !== "low", "explicit week-long span is not a low-confidence guess");
}

console.log("\nchangeScope — gap hunters (S1 original):");
{
  const r = changeScope({ message: "My gym's squat rack is broken until Thursday", today: MON }); // Monday -> Thu = 4 days inclusive
  ok(r.days >= 2, "GAP HUNTER: 'until Thursday' with no travel word at all still resolves 2+ days");
  ok(r.confidence === "high", "an explicit named weekday is a high-confidence read, not a guess");
  ok(r.signal === "weekday_range", "'until Thursday' signal is weekday_range");
}
{
  const day1 = changeScope({ message: "Hotel gym only, no barbell, improvising", today: MON });
  const day2 = changeScope({ message: "Still at the hotel, no barbell again", today: new Date("2026-09-08T12:00:00Z") });
  const day3 = changeScope({ message: "Last day at the hotel, same deal", today: new Date("2026-09-09T12:00:00Z") });
  ok(day1.days === 1, "GAP HUNTER: trip day 1, bare mention, no duration language → stays a day edit");
  ok(day2.days === 1, "GAP HUNTER: trip day 2, same shape → stays a day edit");
  ok(day3.days === 1, "GAP HUNTER: trip day 3, same shape → stays a day edit");
  ok(day1.confidence === "low" && day2.confidence === "low" && day3.confidence === "low",
    "none of the three carry a real duration signal → all low confidence (a guess, not a read)");
}
{
  const r = changeScope({ message: "Even on the road plan, no shoes for tonight's lift specifically", today: MON });
  ok(r.days === 1, "a today-only tweak reads as 1 day regardless of any existing temp program");
}
{
  const plan = "Day 1 - Push\nBench 3x5\nDay 2 - Pull\nRow 3x8\nDay 3 - Legs\nSquat 3x5";
  const r = changeScope({ message: "Only have bands and a pull-up bar where I'm at", extractedText: plan, today: MON });
  ok(r.days === 3, "GAP HUNTER: no duration wording at all, but the extracted plan itself lays out 3 days → 3");
  ok(r.confidence === "medium", "day-header-derived count is medium confidence, not a guess and not a direct read");
  ok(r.signal === "day_headers", "day-header fallback signal is day_headers");
}
{
  const r = changeScope({ message: "No belt today, coach", today: MON });
  ok(r.days === 1, "coach-locked-or-not is irrelevant to changeScope; scope reads the same either way");
}
{
  const r = changeScope({ message: "Subbed dumbbells for barbell today, no rack available", today: MON });
  ok(r.days === 1, "changeScope reads the same regardless of message origin — fromQuickLog is App.jsx's own gate");
}

console.log("\nchangeScope — additional duration phrasings (S1 original):");
ok(changeScope({ message: "for 3 days I won't have a barbell", today: MON }).days === 3, "'for N days' → N");
ok(changeScope({ message: "this week I'm stuck with resistance bands only", today: MON }).days === 7, "'this week' with no programShape → 7 (conservative default)");
ok(changeScope({ message: "this week I'm stuck with resistance bands only", programShape: { trainingDaysPerWeek: 5 }, today: MON }).days === 5,
  "'this week' with a known programShape → the program's own training days per week");
ok(changeScope({ message: "traveling for a week starting tomorrow, hotel gym only", today: MON }).days === 7, "'traveling for a week' → 7");
ok(changeScope({ message: "rest of the trip I'm on dumbbells only", today: MON }).days >= 2, "'rest of the trip' → multi-day");
ok(changeScope({ message: "for a few days I'll be on bodyweight only", today: MON }).days === 3, "'for a few days' → 3 (conservative estimate)");
{
  const r = changeScope({ message: "no shoes, whatever, I'll figure it out", today: MON });
  ok(r.days === 1 && r.confidence === "low", "no duration signal, no extracted plan → today-only, low confidence (never a silent overwrite)");
  ok(r.signal === "unclear", "no-signal fallback is signal:unclear");
}
{
  const r = changeScope({ message: "I'm fine today but traveling this week starting tomorrow, no gear", today: MON });
  ok(r.days >= 2, "an explicit multi-day span in the same message as 'today' still wins (the real situation, not the throwaway word)");
}

console.log("\nchangeScope — TIMEZONE BUG (S1c): the athlete's LOCAL day, not UTC.");
{
  // The exact reported bug: "rack is broken until Thursday" said at 10:30pm
  // Eastern on a Wednesday (2026-09-09). Local Wednesday -> Thursday = 2 days
  // (Wed+Thu). The old getUTCDay() code read this UTC instant as already
  // Thursday 02:30 (Sept 10), pushing "until Thursday" a full week out and
  // returning 8. Explicit numeric UTC offset + explicit `tz` keeps this
  // assertion exact on any machine, regardless of that machine's own zone.
  const wedNightEastern = new Date("2026-09-09T22:30:00-04:00");
  const r = changeScope({ message: "rack is broken until Thursday", today: wedNightEastern, tz: "America/New_York" });
  ok(r.days === 2, `TIMEZONE BUG: 'until Thursday' at 10:30pm Eastern Wed → 2 days local, got ${r.days} (bug returned 8)`);
  ok(r.days !== 8, "TIMEZONE BUG: must never reproduce the old 8-day UTC-rollover answer");
}
{
  // Same class of bug, opposite direction: late Saturday night Pacific is
  // already Sunday in UTC. "until Sunday" said Saturday 11:45pm Pacific must
  // read as Sat+Sun = 2 days locally, not roll a full week to 8.
  const satNightPacific = new Date("2026-09-12T23:45:00-07:00"); // Saturday local, PDT
  const r = changeScope({ message: "the gym's closed until Sunday for the holiday", today: satNightPacific, tz: "America/Los_Angeles" });
  ok(r.days === 2, `TIMEZONE BUG: 'until Sunday' at 11:45pm Pacific Sat → 2 days local, got ${r.days}`);
}
{
  // No explicit tz: the real browser call site passes `new Date()` straight
  // through, so local getters read the athlete's OWN device zone by
  // definition. Constructing `today` via local components (no offset in the
  // literal) keeps this assertion self-consistent on whatever machine runs
  // the suite — writing and reading both happen in that same implicit local
  // frame, so the weekday math can never disagree with itself.
  const localWed = new Date(2026, 8, 9, 22, 30); // Sept 9 2026, 10:30pm, in the TEST MACHINE's own local zone
  const r = changeScope({ message: "rack is broken until Thursday", today: localWed });
  ok(r.days === 2, `TIMEZONE BUG (no tz, default local getters): got ${r.days}, expected 2`);
}

console.log("\nchangeScope — Signal 1: weekday ranges (S1c REQUIRED #1):");
ok(changeScope({ message: "out of town Friday to Sunday, hotel gym", today: MON }).days === 3, "'Friday to Sunday' → 3");
{
  const r = changeScope({ message: "out of town Fri-Sun, hotel gym", today: MON });
  ok(r.days === 3 && r.signal === "weekday_range", "'Fri-Sun' → 3, signal weekday_range");
}
ok(changeScope({ message: "away Friday through Monday, no equipment", today: MON }).days === 4, "'Friday through Monday' → 4");
ok(changeScope({ message: "traveling from Friday until Sunday, hotel gym only", today: MON }).days === 3, "'from Friday until Sunday' → 3");
ok(changeScope({ message: "gym is closed Thursday and Friday for maintenance", today: MON }).days === 2, "'Thursday and Friday' → 2");

console.log("\nchangeScope — Signal 2: date ranges (S1c REQUIRED #2):");
ok(changeScope({ message: "I'll be on a cruise from the 3rd to the 9th", today: MON }).days === 7, "'from the 3rd to the 9th' → 7");
{
  const r = changeScope({ message: "away Oct 3-9, no equipment at all", today: MON });
  ok(r.days === 7 && r.signal === "date_range", "'Oct 3-9' → 7, signal date_range");
}
ok(changeScope({ message: "on the road 10/3 to 10/9, hotel gym", today: MON }).days === 7, "'10/3 to 10/9' → 7");
ok(changeScope({ message: "gym's closed until the 12th for renovations", today: MON }).days >= 2, "'until the 12th' → multi-day");
ok(changeScope({ message: "we're without a rack through October 5", today: MON }).days >= 2, "'through October 5' → multi-day");

console.log("\nchangeScope — Signal 3: relative spans (S1c REQUIRED #3):");
ok(changeScope({ message: "no barbell tomorrow and the day after", today: MON }).days === 2, "'tomorrow and the day after' → 2");
ok(changeScope({ message: "the next two days I'm stuck with bands only", today: MON }).days === 2, "'the next two days' → 2");
ok(changeScope({ message: "next two weeks I'm at a gym with no platform", today: MON }).days === 14, "'next two weeks' → 14");
ok(changeScope({ message: "for 2 weeks I'll only have dumbbells", today: MON }).days === 14, "'for 2 weeks' → 14");
ok(changeScope({ message: "for the next month I'm without a real gym", today: MON }).days >= 2, "'for the next month' → multi-day");
ok(changeScope({ message: "all week I'm working from the hotel gym", today: MON }).days === 7, "'all week' → 7");
ok(changeScope({ message: "all next week I'm traveling for work, hotel gym", today: MON }).days === 7, "'all next week' → 7");
ok(changeScope({ message: "over the weekend I'm at a cabin with no gear", today: MON }).days === 2, "'over the weekend' → 2");
ok(changeScope({ message: "I'm at my parents house through the weekend, just bands and a kettlebell", today: MON }).days === 2, "'through the weekend' → 2");
ok(changeScope({ message: "this weekend I'm out of town, no equipment", today: MON }).days === 2, "'this weekend' → 2");
ok(changeScope({ message: "home gym only til I get back next month", today: MON }).days >= 2, "'til I get back next month' (stated return) → multi-day");
ok(changeScope({ message: "just bodyweight until I get back Sunday", today: MON }).days >= 2, "'until I get back Sunday' (stated return) → multi-day");
{
  const r = changeScope({ message: "home gym only til I get back, not sure exactly when", today: MON });
  ok(r.days === 1, "'til I get back' with NO stated return stays 1 day (conservative default, not escalated)");
}
ok(changeScope({ message: "for a while I'll just have dumbbells at home", today: MON }).days >= 2, "'for a while' → multi-day, medium confidence");
{
  const r = changeScope({ message: "for the foreseeable future I'm on a home gym setup", today: MON });
  ok(r.days >= 2 && r.confidence === "medium", "'for the foreseeable future' → multi-day, medium confidence");
}

console.log("\nchangeScope — orchestrator's independent multi-day probe (must now score 2+):");
const orchestratorCases = [
  "no barbell tomorrow and the day after",
  "I'm at my parents house through the weekend, just bands and a kettlebell",
  "out of town Friday to Sunday, hotel gym",
  "I'll be on a cruise from the 3rd to the 9th",
  "next two weeks I'm at a gym with no platform",
  "home gym only til I get back next month",
];
for (const message of orchestratorCases) {
  const r = changeScope({ message, today: MON });
  ok(r.days >= 2, `ORCHESTRATOR CASE now multi-day: "${message}" → days=${r.days}`);
}

console.log("\nchangeScope — single-day forms that MUST stay 1 (S1c REQUIRED #4):");
{
  const r = changeScope({ message: "tomorrow I won't have a spotter", today: MON });
  ok(r.days === 1, "'tomorrow' alone → 1 day");
}
{
  const r = changeScope({ message: "gym is closed for the holiday monday", today: MON });
  ok(r.days === 1, "'Monday' alone with no range/connector → 1 day");
}
ok(changeScope({ message: "no plates today, working around it", today: MON }).days === 1, "'today' alone → 1 day");
ok(changeScope({ message: "tonight I'm short on time, cutting accessories", today: MON }).days === 1, "'tonight' alone → 1 day");
ok(changeScope({ message: "this session I've only got dumbbells", today: MON }).days === 1, "'this session' alone → 1 day");

console.log("\nchangeScope — trainingDays estimate from programShape:");
{
  const r = changeScope({ message: "out of town Friday to Sunday, hotel gym", programShape: { trainingDaysPerWeek: 4 }, today: MON });
  ok(r.days === 3, "weekday range days unaffected by programShape");
  ok(Number.isFinite(r.trainingDays), "trainingDays present when programShape given");
  ok(r.trainingDays === Math.round(3 * 4 / 7), "trainingDays estimated proportionally from trainingDaysPerWeek");
}
{
  const r = changeScope({ message: "no shoes, whatever, I'll figure it out", today: MON });
  ok(r.trainingDays === undefined, "trainingDays omitted when no programShape given");
}

console.log("\nchangeScope — table test: 20 more multi-day paraphrases (must be days >= 2):");
const multiDayParaphrases = [
  "gone Saturday to Monday, just resistance bands",
  "off the grid Wed-Fri, no barbell at all",
  "at a cabin from Thursday until Sunday, bodyweight only",
  "camp runs Monday and Tuesday, no rack either day",
  "we're away from the 14th to the 20th, hotel gym only",
  "conference is Nov 4-8, hotel gym the whole time",
  "leaving 12/20 to 12/27 for the holidays, no equipment",
  "out until the 15th, only have a resistance band",
  "on the road through November 3, hotel gyms only",
  "no gear tomorrow and the day after, small apartment gym only",
  "the next three days I'm stuck with just a kettlebell",
  "next three weeks I'm coaching a camp, barely any equipment",
  "for 3 weeks I'll be traveling for work, hotel gyms",
  "for the next 6 weeks I'll be coaching at a summer camp, barely any equipment",
  "all week I've got nothing but a pull-up bar",
  "all next week the gym's shut for renovations, no equipment",
  "this weekend we're camping, no gear whatsoever",
  "over the weekend I'm at a wedding, no gym access",
  "until I get back next month I've only got dumbbells",
  "for the foreseeable future I'm rehabbing at a small gym with limited plates",
];
for (const message of multiDayParaphrases) {
  const r = changeScope({ message, today: MON });
  ok(r.days >= 2, `MULTI-DAY PARAPHRASE: "${message}" → days=${r.days}, confidence=${r.confidence}, signal=${r.signal}`);
}

console.log("\nchangeScope — table test: 20 more single-day paraphrases (must stay days === 1):");
const singleDayParaphrases = [
  "no belt today, making do",
  "today's the only day I'm without a rack",
  "just for tonight I'm working out at home",
  "this session I'm skipping the barbell work",
  "tomorrow's lift will just be dumbbells",
  "gym's closed monday for the holiday, that's it",
  "no chalk today, hands are fine",
  "subbing in bodyweight for today's leg day",
  "this workout I'm short on time, trimming volume",
  "right now I'm at a friend's place, bodyweight only",
  "just today I don't have my belt",
  "tonight only, doing this from a hotel gym",
  "today I forgot my shoes, using flats instead",
  "this lift I'm swapping bench for dumbbell press",
  "no platform today, doing power cleans off blocks",
  "today the rack's taken, using the smith machine instead",
  "just this session, subbing bands for the barbell",
  "tuesday the gym's closed, that's the only day affected",
  "tonight I'm cutting the accessory work short",
  "today only, training in the garage instead of the gym",
];
for (const message of singleDayParaphrases) {
  const r = changeScope({ message, today: MON });
  ok(r.days === 1, `SINGLE-DAY PARAPHRASE must stay 1: "${message}" → days=${r.days}, confidence=${r.confidence}, signal=${r.signal}`);
}

console.log(`\n${fail === 0 ? "✓" : "✗"} change-scope: ${fail === 0 ? "all checks" : fail + " checks"} ${fail === 0 ? "passed" : "failed"}.`);
process.exit(fail === 0 ? 0 : 1);
