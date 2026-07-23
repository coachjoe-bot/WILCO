// ─── COACH MORNING BRIEF REGRESSION SUITE ────────────────────────────────────
// coachBrief.js is pure, deterministic and explicitly test-designed: same inputs
// must always produce the same beats, and the ONLY source of phrasing variance is
// dateKey. It drives what a coach is told needs them each morning, so a silent
// regression here means a real concern (injury, quiet athlete) stops surfacing.
//
// Also pins the two behaviors changed on 2026-07-22:
//   A18 — answered questions are skipped instead of re-asked every day
//   A21 — the trend beat judges the last COMPLETE week before Saturday, matching
//         the Team Volume card (it used to grade the partial current week)
//
//   node scripts/test-coach-brief.mjs
//
import { buildMorningBrief, briefWeekKey, decisionNote } from "../src/coachBrief.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
};
const truthy = (name, got) => check(name, !!got, true);

const athlete = (id, name) => ({ id, name, sport: "Football" });
const ATHLETES = [athlete("a1", "Marcus Ellison"), athlete("a2", "Ava Sinclair"), athlete("a3", "Diego Marin")];
// Minimal D (the CoachOverview memo output) — only the fields the brief reads.
const D = ({ triage = [], volWeeks = [100, 100, 100, 100], todayIdx = 6, ...rest } = {}) => ({
  rows: ATHLETES.map((a) => ({ a, score: 80 })),
  triage, volWeeks, todayIdx,
  prThisWk: 3, activeCount: 2, activePct: 67, teamAdh: 80, wins: [], inactive: [],
  ...rest,
});
const DAY = "2026-07-22";
const beatsOf = (opts) => buildMorningBrief({ D: D(opts.D || {}), athletes: ATHLETES, dateKey: DAY, ...opts.args }).beats;
const kinds = (bs) => bs.map((b) => b.kind);

console.log("determinism + shape:");
const b1 = buildMorningBrief({ D: D(), athletes: ATHLETES, dateKey: DAY });
const b2 = buildMorningBrief({ D: D(), athletes: ATHLETES, dateKey: DAY });
check("same inputs produce byte-identical output", JSON.stringify(b1), JSON.stringify(b2));
truthy("always opens with an opening beat", kinds(b1.beats)[0] === "opening");
truthy("a clean roster gets an allclear beat", kinds(b1.beats).includes("allclear"));
// roster size is athletes.length OR D.rows.length — an empty athletes array with
// a populated D still has a roster, so the empty case must clear both.
check("a genuinely empty roster degrades gracefully",
  buildMorningBrief({ D: { ...D(), rows: [] }, athletes: [], dateKey: DAY }).headline, "No roster yet");
check("an empty athletes array still uses D.rows for the roster size",
  buildMorningBrief({ D: D(), athletes: [], dateKey: DAY }).headline !== "No roster yet", true);

console.log("\nconcerns + triage order (injury > quiet > adherence > plateau):");
const TRIAGE = [
  { id: "a3", kind: "Plateau", name: "Diego Marin" },
  { id: "a1", kind: "Quiet", name: "Marcus Ellison" },
  { id: "a2", kind: "Injury", name: "Ava Sinclair" },
];
const withConcerns = beatsOf({ D: { triage: TRIAGE } });
check("concerns are ranked injury, then quiet, then plateau",
  withConcerns.filter((b) => b.kind === "concern").map((b) => b.athleteId), ["a2", "a1", "a3"]);
truthy("a roster with concerns has no allclear beat", !kinds(withConcerns).includes("allclear"));
check("a decided concern is suppressed for the week",
  beatsOf({ D: { triage: TRIAGE }, args: { cleared: new Set(["a2:injury"]) } })
    .filter((b) => b.kind === "concern").map((b) => b.athleteId), ["a1", "a3"]);
check("clearing every concern brings the allclear back",
  kinds(beatsOf({ D: { triage: TRIAGE }, args: { cleared: new Set(["a2:injury", "a1:quiet", "a3:plateau"]) } })).includes("allclear"), true);

console.log("\nA18 — answered questions are not re-asked:");
const qIds = (bs) => bs.filter((b) => b.kind === "question").map((b) => b.question.id);
const asked = qIds(beatsOf({ D: { triage: TRIAGE } }));
truthy("a brief asks at least one question", asked.length > 0);
check("at most two questions per day", asked.length <= 2, true);
const afterAnswer = qIds(beatsOf({ D: { triage: TRIAGE }, args: { answeredQuestionIds: new Set(asked) } }));
check("previously answered questions are gone", afterAnswer.filter((id) => asked.includes(id)), []);
check("answering every fallback leaves no repeat question rather than looping",
  qIds(beatsOf({ args: { answeredQuestionIds: new Set(["fallback:goal", "fallback:season", "fallback:response"]) } })), []);

console.log("\nA21 — trend beat matches the Team Volume card's week rule:");
const trendText = (volWeeks, todayIdx) =>
  beatsOf({ D: { volWeeks, todayIdx } }).find((b) => b.kind === "trend").prose;
// Mon-Fri (todayIdx<5): judge the last COMPLETE week (vw[2]), phrased as last week.
truthy("a mid-week spike in the last COMPLETE week is reported",
  /last week|last complete/i.test(trendText([100, 100, 200, 10], 1)));
truthy("a partial current week is NOT graded early in the week",
  !/last week/i.test(trendText([100, 100, 100, 100], 6)) );
truthy("from Saturday the CURRENT week is graded",
  /up \d+%/i.test(trendText([100, 100, 100, 200], 6)));
truthy("a tiny partial week early on does not print a false spike",
  !/up \d+%/.test(trendText([100, 100, 100, 5], 1)));

console.log("\nphrasing variance is keyed ONLY on dateKey:");
const proseFor = (d) => buildMorningBrief({ D: D(), athletes: ATHLETES, dateKey: d }).beats[0].prose;
truthy("a different day can phrase the opening differently",
  new Set(["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"].map(proseFor)).size > 1);
check("the same day always phrases it the same", proseFor(DAY), proseFor(DAY));

console.log("\nbriefWeekKey + decisionNote:");
check("the week key is stable across a Mon-Sun week",
  briefWeekKey(new Date("2026-07-20T12:00:00Z")), briefWeekKey(new Date("2026-07-24T12:00:00Z")));
truthy("the week key rolls over into the next week",
  briefWeekKey(new Date("2026-07-20T12:00:00Z")) !== briefWeekKey(new Date("2026-07-28T12:00:00Z")));
const injuryBeat = withConcerns.find((b) => b.kind === "concern" && b.athleteId === "a2");
truthy("a decision note names the athlete and the call",
  /Ava Sinclair/.test(decisionNote(injuryBeat, (injuryBeat.actions[0] || {}).id)));

console.log(`\n${fail === 0 ? "All" : ""} ${pass} coach-brief checks pass${fail ? `, ${fail} FAILED` : "."}`);
process.exit(fail === 0 ? 0 : 1);
