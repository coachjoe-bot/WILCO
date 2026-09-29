// changeScope regression suite — run with: node scripts/test-change-scope.mjs
// T64 Fix 4 (extended in S1c): does a described equipment/condition change
// span one training day or two-plus? Pure, deterministic, no network. Cases
// pulled from the T64 diagnosis (BUG 4), its gap hunters, the orchestrator's
// independent multi-day probe, and the S1c timezone-bug report.

import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changeScope, conversationWindow, conversationScope, countPlanDays, planSlice, isProgramEcho, findRecentPlan, tempTurnBefore, decideTempWrite, tempProgramFact, tempConfirmLine } from "../src/changeScope.js";
import { asksTempProgram } from "../src/chatRouting.js";
const here = dirname(fileURLToPath(import.meta.url));

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

// ── Parser span fills in when the phrases are unclear (integration) ─────────
console.log("\nchangeScope — parser span fallback:");
{
  const mon = new Date("2026-09-28T14:00:00-04:00");
  const c = (message, parserDays) => changeScope({ message, today: mon, tz: "America/New_York", parserDays });
  ok(c("visiting family Wed through next Tuesday, they have a garage gym", 7).days >= 2, "unclear phrase + parser says 7 days must be multi-day");
  // S6: the phrase itself now reads ("next" before the end day), so the words
  // win and the parser is not needed for this one.
  ok(c("visiting family Wed through next Tuesday, they have a garage gym", null).days >= 2, "S6: 'Wed through next Tuesday' reads on its own");
  ok(c("I'm in a boot for a month, upper body only", null).days >= 2, "S6: 'for a month' reads on its own");
  ok(c("I'm in a boot for a month, upper body only", 30).days >= 2, "a month in a boot must be multi-day");
  ok(c("hotel gym only has dumbbells", null).days === 1, "no duration anywhere must stay one day");
  ok(c("hotel gym only has dumbbells", 1).days === 1, "parser says one day must stay one day");
  ok(c("I don't have my weightlifting shoes with me, doing push press in place of today's workout", 5).days === 1, "a clear today-only phrase must beat the parser");
  ok(c("rack is broken until Thursday", null).days >= 2, "a clear phrase needs no parser");
  ok(c("forgot my belt", "lots").days === 1, "a junk parser value must be ignored");
}


// ── T64 S6: scope over the CONVERSATION (verifier BUG-3) ────────────────────
console.log("\nconversation window + temp program (S6, BUG-3):");
const rp = JSON.parse(fs.readFileSync(join(here, "../tests/replay/temp-program-three-turns.json"), "utf8"));
const NOW = new Date(rp.now);
const ago = (min) => NOW.getTime() - min * 60000;
// Build the transcript as send() sees it: every user message stamped `at`,
// Joe's replies in between, the current message last.
const transcript = (upToTurn, { joeLast = false } = {}) => {
  const out = [];
  rp.turns.slice(0, upToTurn).forEach((t, i) => {
    out.push({ role: "user", content: t.athlete, at: ago(t.minutesAgo) });
    const isLast = i === upToTurn - 1;
    if (!isLast || joeLast) if (t.joe) out.push({ role: "assistant", content: t.joe });
  });
  return out;
};
const ATH = rp.athlete;
{
  // Turn 1 alone: span stated, Joe only asks a question → nothing written.
  const d = decideTempWrite({ messages: transcript(1), now: NOW, reply: rp.turns[0].joe, flagged: false, athlete: ATH, tz: rp.tz });
  ok(!d.write, "turn 1: Joe asks about equipment, no plan → no write");
  const pre = tempTurnBefore({ messages: transcript(1), now: NOW, athlete: ATH, explicitAsk: asksTempProgram(rp.turns[0].athlete) });
  ok(pre.inPlay && pre.scope.days >= 2, "turn 1: the stated span puts a temp program in play before Joe speaks");
  ok(/NO temporary program is saved, and you have not laid out/.test(tempProgramFact({ athlete: ATH, recentPlanFound: pre.plan })), "turn 1 fact: nothing saved, no plan yet");
}
{
  // Turn 2: the equipment message carries NO span; the span is two messages up.
  ok(changeScope({ message: rp.turns[1].athlete, today: NOW }).days === 1, "turn 2 message alone reads as one day (the original bug)");
  const scope = conversationScope({ messages: transcript(2), now: NOW, tz: rp.tz });
  ok(scope.days >= 2 && scope.source === "window", "turn 2: the window carries the span stated one message earlier");
  const d = decideTempWrite({ messages: transcript(2), now: NOW, reply: rp.turns[1].joe, flagged: false, athlete: ATH, tz: rp.tz });
  ok(d.write && d.source === rp.expect.turn2.source, "turn 2: Joe lays out a 6-day plan with no parser flag → written from his reply");
  ok(planSlice(rp.turns[1].joe).startsWith(rp.expect.planSliceStartsWith), "the deterministic plan cut starts at the first day header, markdown stripped");
  ok(!/Real bench progression/.test(planSlice(rp.turns[1].joe)), "the closing prose paragraph is not part of the saved plan");
  ok(countPlanDays(rp.turns[1].joe) >= 5, "the plan's day headers count (bold, parenthesized)");
  // Coach-locked athlete: same decision (temp_program_text is its own column),
  // the confirmation names the coach.
  const locked = decideTempWrite({ messages: transcript(2), now: NOW, reply: rp.turns[1].joe, flagged: false, athlete: { ...ATH, program_locked: true }, tz: rp.tz });
  ok(locked.write, "coach-locked athlete: the temp program is still written (Field Mode stays open to locked athletes)");
  ok(/coach's program is untouched/.test(tempConfirmLine({ locked: true })) && !/coach/.test(tempConfirmLine({ locked: false })), "confirmation line: coach wording only for a locked athlete");
  // Quick Log send and a prefill_log_sheet turn never write.
  ok(!decideTempWrite({ messages: transcript(2), now: NOW, reply: rp.turns[1].joe, athlete: ATH, fromQuickLog: true }).write, "a log-sheet send never writes a temp program");
  ok(!decideTempWrite({ messages: transcript(2), now: NOW, reply: rp.turns[1].joe, athlete: ATH, joeHandledToday: true }).write, "Joe's own prefill_log_sheet this turn = his today-only call, no write");
}
{
  // Turn 3, the exact failing ask — plan found in the window, unsaved.
  const msgs = transcript(3);
  ok(asksTempProgram(rp.turns[2].athlete), "turn 3: 'yes set me up with that temporary program for the week' is an explicit ask");
  const pre = tempTurnBefore({ messages: msgs, now: NOW, athlete: ATH, explicitAsk: true });
  ok(pre.plan && pre.plan.days >= rp.expect.turn3.planDaysAtLeast, "turn 3: the most recent plan Joe laid out is found in the window");
  ok(pre.writePlan && pre.reason === "explicit_ask", "turn 3: the explicit ask writes that plan");
  ok(tempProgramFact({ athlete: ATH, recentPlanFound: pre.plan }).includes(rp.expect.turn3.factBeforeWrite), "without a write, the fact says the plan has NOT been saved");
  ok(/saving the day-by-day plan/.test(tempProgramFact({ athlete: ATH, recentPlanFound: pre.plan, savingNow: true })), "with the write in flight, the fact says the app is saving it now");
  // Already auto-saved at turn 2 (message flagged tempSaved) → no second write, fact says saved.
  const savedMsgs = msgs.map((m) => (m.role === "assistant" && m.content === rp.turns[1].joe ? { ...m, tempSaved: true } : m));
  const savedAth = { ...ATH, temp_program_text: "Wednesday (Push, DB version):\n1. DB Bench Press 4x8 @ 50s" };
  const pre2 = tempTurnBefore({ messages: savedMsgs, now: NOW, athlete: savedAth, explicitAsk: true });
  ok(!pre2.writePlan && pre2.reason === "already_saved", "plan already saved at turn 2 → the ask does not write it twice");
  ok(/IS saved and active; its first line is "Wednesday \(Push, DB version\):"/.test(tempProgramFact({ athlete: savedAth, recentPlanFound: pre2.plan })), "fact: saved, with its first line");
  // Reverted since ("I'm back home" cleared it) → asking again re-writes.
  const pre3 = tempTurnBefore({ messages: savedMsgs, now: NOW, athlete: ATH, explicitAsk: true });
  ok(pre3.writePlan, "saved once, then cleared by a revert → an explicit ask writes it again");
  // Post-reply decision must not double-write after the explicit path wrote.
  ok(!decideTempWrite({ messages: msgs, now: NOW, reply: rp.turns[2].joeObserved, athlete: ATH, explicitWrote: true }).write, "explicit ask wrote before the reply → no second write after it");
}
{
  // Explicit ask with NO plan in the window → nothing written, Joe told so.
  const msgs = [{ role: "user", content: "yes set me up with that temporary program for the week", at: NOW.getTime() }];
  const pre = tempTurnBefore({ messages: msgs, now: NOW, athlete: ATH, explicitAsk: true });
  ok(!pre.writePlan && pre.reason === "no_plan_in_window", "explicit ask, no plan in the window → no write");
  ok(pre.inPlay && /have not laid out a day-by-day plan/.test(tempProgramFact({ athlete: ATH, recentPlanFound: pre.plan })), "and Joe's fact says no plan exists, so he lays one out");
}
{
  // Span stated, then "actually just today" → today wins over the older span.
  const msgs = [
    { role: "user", content: "visiting family Wed through next Tuesday, garage gym only", at: ago(5) },
    { role: "assistant", content: "What's in the garage?" },
    { role: "user", content: "actually never mind, it's just today", at: NOW.getTime() },
  ];
  const sc = conversationScope({ messages: msgs, now: NOW });
  ok(sc.signal === "today_only" && sc.days === 1, "span then 'actually just today' → today-only wins");
  ok(!decideTempWrite({ messages: msgs, now: NOW, reply: rp.turns[1].joe, flagged: true, athlete: ATH }).write, "…and no temp program, even with a plan in the reply and the parser flag");
}
{
  // Span stated 3 hours ago = out of the 60-minute window.
  const msgs = [
    { role: "user", content: "visiting family Wed through next Tuesday, garage gym only", at: ago(180) },
    { role: "assistant", content: "What's in the garage?" },
    { role: "user", content: "just some dumbbells up to 50lb and an adjustable bench, no barbell", at: NOW.getTime() },
  ];
  const w = conversationWindow(msgs, NOW);
  ok(w.users.length === 1, "a message 3 hours old is outside the window");
  ok(conversationScope({ messages: msgs, now: NOW }).days === 1, "span stated 3 hours ago does not count");
  ok(!decideTempWrite({ messages: msgs, now: NOW, reply: rp.turns[1].joe, flagged: false, athlete: ATH }).write, "…so a plan now, with no flag, is not written");
  // More than 6 athlete messages back is out too.
  const many = [{ role: "user", content: "traveling for a week, hotel gym", at: ago(20) }];
  for (let i = 0; i < 6; i++) many.push({ role: "user", content: `question ${i}`, at: ago(10 - i) });
  ok(conversationWindow(many, NOW).users.length === 6 && conversationScope({ messages: many, now: NOW }).days === 1, "the 7th-newest athlete message is outside the window");
  // A message with no timestamp (pre-S6 transcript) never counts.
  const unstamped = [{ role: "user", content: "traveling for a week, hotel gym" }, { role: "user", content: "what should I do", at: NOW.getTime() }];
  ok(conversationScope({ messages: unstamped, now: NOW }).days === 1, "an unstamped message (unknown age) is outside the window");
}
{
  // A plan with only one day header is not a day-by-day plan.
  const one = "Here's today, hotel version.\n\n**Wednesday (Push, DB version):**\n1. DB Bench Press 4x8 @ 50s\n2. DB Fly 3x12 @ 25s";
  ok(countPlanDays(one) === 1, "one day header counts 1");
  ok(!decideTempWrite({ messages: transcript(2), now: NOW, reply: one, flagged: false, athlete: ATH }).write, "a one-day plan is never written as a temp program");
  // Prose that names days is not a plan.
  ok(countPlanDays(rp.turns[2].joeObserved) === 0, "\"Wednesday's your push day, then pull...\" prose has no headers");
  ok(findRecentPlan({ messages: [{ role: "user", content: "x", at: NOW.getTime() - 1000 }, { role: "assistant", content: one }, { role: "user", content: "y", at: NOW.getTime() }], now: NOW }) === null, "a one-day reply is not a recent plan");
}
{
  // The regular program read back is not a temp plan.
  const echo = "Here's your week:\n\nDay 1 - Push\nBench Press 4x5 @ 185\nOverhead Press 3x8 @ 95\nDips 3x8\n\nDay 2 - Pull\nBarbell Row 4x8 @ 135\nPull-ups 3x8";
  ok(isProgramEcho(planSlice(echo), [ATH.program_text]), "the regular program echoed back is detected");
  const msgs = [{ role: "user", content: "I'm busy this week at the gym, what's my week look like", at: NOW.getTime() }];
  ok(!decideTempWrite({ messages: msgs, now: NOW, reply: echo, flagged: true, athlete: ATH }).write || decideTempWrite({ messages: msgs, now: NOW, reply: echo, flagged: true, athlete: ATH }).source === "legacy_reply", "an echo is never saved as the plan itself");
  ok(!decideTempWrite({ messages: msgs, now: NOW, reply: echo, flagged: false, athlete: ATH }).write, "no flag + echoed program → no write");
  ok(!isProgramEcho(planSlice(rp.turns[1].joe), [ATH.program_text]), "Joe's dumbbell plan is not an echo");
}
{
  // The founder's original no-shoes message: no temp program, even with a plan-shaped reply and the flag.
  const noShoes = "I don't have my weightlifting shoes with me so I can't really do snatch balance. I am thinking of doing behind the neck push press at a snatch grip and push press and then some other shoulder work in place of today's workout.";
  const msgs = [{ role: "user", content: noShoes, at: NOW.getTime() }];
  ok(!decideTempWrite({ messages: msgs, now: NOW, reply: rp.turns[1].joe, flagged: true, athlete: ATH }).write, "founder's no-shoes message → no temp program");
  ok(!tempTurnBefore({ messages: msgs, now: NOW, athlete: ATH, explicitAsk: asksTempProgram(noShoes) }).writePlan, "…and it is not an explicit ask");
}
{
  // Legacy flag path preserved: flag + a stated span + Joe's reply with no day names.
  const msgs = [{ role: "user", content: "I'm at a hotel this week with no gear, just dumbbells.", at: NOW.getTime() }];
  const d = decideTempWrite({ messages: msgs, now: NOW, reply: "Got it, dumbbells only for the week. I'll get you a plan set up.", flagged: true, athlete: ATH });
  ok(d.write && d.source === "legacy_reply", "flag + multi-day + no plan headers → legacy extraction of the reply (unchanged behavior)");
  // "starting today" opens a span; it is not today-only.
  ok(conversationScope({ messages: [{ role: "user", content: "hotel gym for the next 5 days starting today", at: NOW.getTime() }], now: NOW }).days >= 2, "'starting today' does not make a span today-only");
}
{
  // asksTempProgram: the spec's phrasings, and things that are not the ask.
  for (const t of ["set me up with that temporary program", "make that my temp program", "save that as my travel plan", "lock that in for the week", "yes set me up with that temporary program for the week", "can you set me up with a travel program?", "switch me to the dumbbell version", "use that plan"]) ok(asksTempProgram(t), `explicit ask: "${t}"`);
  for (const t of ["make the program harder", "use this program: Day 1 Squat 5x5", "set up a bench session for me", "make me a program", "use dumbbells today", "that program you wrote was great", "I want to lock in my squat form", "set me up with the new program"]) ok(!asksTempProgram(t), `not an ask: "${t}"`);
}

console.log(`\n${fail === 0 ? "✓" : "✗"} change-scope: ${fail === 0 ? "all checks" : fail + " checks"} ${fail === 0 ? "passed" : "failed"}.`);
process.exit(fail === 0 ? 0 : 1);
