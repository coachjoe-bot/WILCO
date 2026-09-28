// changeScope regression suite — run with: node scripts/test-change-scope.mjs
// T64 Fix 4: does a described equipment/condition change span one training day
// or two-plus? Pure, deterministic, no network. Cases pulled from the T64
// diagnosis (BUG 4) plus its listed gap hunters.

import { changeScope } from "../src/changeScope.js";

let fail = 0;
const bad = (msg) => { fail++; console.error("  ✗ " + msg); };
const ok = (cond, msg) => { if (!cond) bad(msg); };

const MON = new Date("2026-09-07T12:00:00Z"); // a real Monday

console.log("changeScope — common paths:");
{
  // Will's REAL message (T64 diagnosis A, BUG 4).
  const r = changeScope({ message: "I don't have my weightlifting shoes with me so I can't really do snatch balance. I am thinking of doing behind the neck push press at a snatch grip and push press and then some other shoulder work in place of today's workout.", today: MON });
  ok(r.days === 1 && r.confidence === "high", "Will's real message: explicit 'today's workout' → 1 day, high confidence");
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

console.log("\nchangeScope — gap hunters:");
{
  // "rack is broken until Thursday" — no travel word at all, still 2+ days.
  const r = changeScope({ message: "My gym's squat rack is broken until Thursday", today: MON }); // Monday -> Thu = 4 days inclusive
  ok(r.days >= 2, "GAP HUNTER: 'until Thursday' with no travel word at all still resolves 2+ days");
  ok(r.confidence === "high", "an explicit named weekday is a high-confidence read, not a guess");
}
{
  // Three separate single-day messages on three different days of one trip —
  // EACH stays a day edit. No accumulation happens inside the pure function
  // (that's the caller's job, per the diagnosis's own gap hunter framing); what
  // matters here is that a bare condition mention with no duration language
  // never itself escalates to multi-day.
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
  // Athlete already on a temp program asks for a today-only tweak — changeScope
  // itself doesn't know about temp-program state (that's the caller's business,
  // per the spec: "leave temp_program_text untouched" either way); it just
  // reads THIS message's own scope.
  const r = changeScope({ message: "Even on the road plan, no shoes for tonight's lift specifically", today: MON });
  ok(r.days === 1, "a today-only tweak reads as 1 day regardless of any existing temp program");
}
{
  // Extracted-plan day headers count even with zero duration language in the
  // athlete's own words.
  const plan = "Day 1 - Push\nBench 3x5\nDay 2 - Pull\nRow 3x8\nDay 3 - Legs\nSquat 3x5";
  const r = changeScope({ message: "Only have bands and a pull-up bar where I'm at", extractedText: plan, today: MON });
  ok(r.days === 3, "GAP HUNTER: no duration wording at all, but the extracted plan itself lays out 3 days → 3");
  ok(r.confidence === "medium", "day-header-derived count is medium confidence, not a guess and not a direct read");
}
{
  // Coach-locked athlete: changeScope doesn't take lock state as input at all —
  // confirms the function is agnostic to it (the caller decides the coach-trace
  // behavior; see the App.jsx integration test in the replay corpus).
  const r = changeScope({ message: "No belt today, coach", today: MON });
  ok(r.days === 1, "coach-locked-or-not is irrelevant to changeScope; scope reads the same either way");
}
{
  // Message sent from the log sheet (fromQuickLog) — again, changeScope itself
  // has no notion of the message's origin; App.jsx's existing !fromQuickLog
  // gate (unchanged by this fix) is what actually protects Quick Log sends.
  const r = changeScope({ message: "Subbed dumbbells for barbell today, no rack available", today: MON });
  ok(r.days === 1, "changeScope reads the same regardless of message origin — fromQuickLog is App.jsx's own gate");
}

console.log("\nchangeScope — additional duration phrasings:");
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
}
{
  // "today" AND an explicit span in the same message — the span wins.
  const r = changeScope({ message: "I'm fine today but traveling this week starting tomorrow, no gear", today: MON });
  ok(r.days >= 2, "an explicit multi-day span in the same message as 'today' still wins (the real situation, not the throwaway word)");
}

console.log(`\n${fail === 0 ? "✓" : "✗"} change-scope: ${fail === 0 ? "all checks" : fail + " checks"} ${fail === 0 ? "passed" : "failed"}.`);
process.exit(fail === 0 ? 0 : 1);
