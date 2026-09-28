// ─── PAIN LEDGER SUITE (T64 S2) ──────────────────────────────────────────────
// Locks the one home for pain state (src/painLedger.js). The founder's real rows
// (tests/replay/founder-pain-fixture.json, read-only snapshot) are the primary
// fixture: knees and pec on Aug 18, Aug 25, Sep 1, Sep 4, Sep 17, Sep 21, Sep 28,
// and knees must read quiet or cleared by Sep 28 with zero athlete action.
// Then every gap hunter from the T64 S2 brief.
// Run: node scripts/test-pain-ledger.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normArea, areasInText, classifyPain, painStatus, extractEvents, withMark, normalizeMarks,
  ledgerBlock, preTurnPain, NEXT_MENTION_DEFAULT, dayKey, extractDuring,
  EPISODE_GAP_DAYS, CLEARED_CLEAN, OFFER_COOLDOWN_DAYS, SEV_SERIOUS, SEV_CHANGED, SEV_AWARE, SEV_DULL,
} from "../src/painLedger.js";
import { programPurpose } from "../src/programPurpose.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error(`✗ ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const has = (s, sub, name) => ok(String(s).includes(sub), `${name} (missing ${JSON.stringify(sub)} in ${JSON.stringify(s)})`);

// ── 1. area taxonomy ─────────────────────────────────────────────────────────
{
  eq(normArea("knee").key, "knee", "knee");
  eq(normArea("knees").key, "knee", "knees -> knee");
  eq(normArea("my left knee").key, "knee", "my left knee -> knee");
  eq(normArea("my left knee").side, "left", "side kept when stated");
  eq(normArea("Knees").side, "both", "plural reads both");
  eq(normArea("kneee").key, "knee", "misspelling kneee");
  eq(normArea("patellar tendon").key, "knee", "clinical: patellar -> knee");
  eq(normArea("rotator cuff").key, "shoulder", "clinical: rotator cuff -> shoulder");
  eq(normArea("sholder").key, "shoulder", "misspelling sholder");
  eq(normArea("SI joint").key, "low_back", "clinical: SI joint -> low back");
  eq(normArea("lower back").key, "low_back", "lower back");
  eq(normArea("back").key, "low_back", "bare back -> low back");
  eq(normArea("upper back").key, "upper_back", "upper back is its own area");
  eq(normArea("left pec").key, "pec", "left pec");
  eq(normArea("chest").key, "pec", "chest -> pec");
  eq(normArea("pectoral").key, "pec", "pectoral -> pec");
  eq(normArea("hammy").key, "hamstring", "hammy");
  eq(normArea("achillies").key, "achilles", "achillies misspelling");
  eq(normArea("IT band").key, "it_band", "IT band");
  eq(normArea("shin splints").key, "shin", "shin splints");
  eq(normArea("groin").key, "groin", "groin");
  eq(normArea("adductor").key, "groin", "adductor -> groin");
  eq(normArea("hip flexor").key, "hip", "hip flexor -> hip");
  eq(normArea("calves").key, "calf", "calves");
  eq(normArea("plantar fascia").key, "foot", "plantar -> foot");
  eq(normArea("tennis elbow").key, "elbow", "tennis elbow");
  eq(normArea("legs").key, "legs", "unknown text falls back to cleaned string");
  eq(normArea("Other aches and pains").key, "other aches and pains", "fallback is lowercase + cleaned");
  const two = areasInText("knees flared again, and my pec too");
  ok(two.includes("knee") && two.includes("pec") && two.length === 2, `two body parts in one message (got ${two})`);
  eq(areasInText("my knee hurt during back squat"), ["knee"], "a lift name is not an area (back squat)");
  eq(areasInText("did toes to bar and chest-supported rows"), [], "toes to bar / chest-supported are lifts");
  const ul = areasInText("upper back and lower back both tight");
  ok(ul.includes("upper_back") && ul.includes("low_back"), "upper and lower back both found");
  eq(areasInText("upper back is tight"), ["upper_back"], "upper back does not also read as low back");
}

// ── 2. classifier (reads every OLD row) ──────────────────────────────────────
{
  const sore = classifyPain({ area: "legs", description: "too sore for today's workout", message: "Today I'm doing week 2 day 1 out of order because my legs are too sore for today's workout" });
  eq(sore.kind, "soreness", "Sep 17 'legs too sore' is soreness, not pain");
  eq(classifyPain({ area: "knees", description: "felt a very small amount during squat volume" }).severity, SEV_AWARE, "'very small amount' = 1");
  eq(classifyPain({ area: "knees", description: "knees were on fire during Front Squat", message: "Front Squat 2x1 @ 100/120 (my knees were on fire so I stopped)" }).severity, SEV_CHANGED, "'on fire, stopped' = 3");
  eq(classifyPain({ area: "knees", description: "avoiding heavy load", message: "I decided to snatch instead of back squat to save my knees from heavy load" }).severity, SEV_DULL, "precaution swap = 2");
  const sharp = classifyPain({ area: "shoulder", description: "sharp pain, felt a pop" });
  eq(sharp.severity, SEV_SERIOUS, "sharp + pop = 4");
  eq(sharp.onset, "sudden", "pop = sudden onset");
  eq(classifyPain({ area: "knee", description: "gave out on the last rep" }).severity, SEV_SERIOUS, "gave out = 4");
  eq(classifyPain({ area: "knee", description: "numbness down the leg" }).severity, SEV_SERIOUS, "numbness = 4");
  eq(classifyPain({ area: "knee", description: "dull ache" }).severity, SEV_DULL, "dull ache = 2");
  eq(classifyPain({ area: "knee", description: "dull ache" }).character, "dull", "character dull");
  eq(classifyPain({ area: "knee", description: "knee feels great now" }).status, "cleared", "'feels great now' = cleared");
  eq(classifyPain({ area: "knee", description: "still hurts but feels better" }).status, null, "'still ... better' is not cleared");
  eq(classifyPain({ area: "pec", description: "felt pec during incline dumbbell bench press, stopped early" }).during, "incline dumbbell bench press", "during extracted");
  eq(extractDuring("Pretty significant pain during bench press, possible strain"), "bench press", "during stops at the comma");
  eq(extractDuring("knees were on fire during Front Squat"), "front squat", "'on fire' is not a lift");
  eq(extractDuring("I decided to snatch instead of back squat to save my knees"), "back squat", "'instead of X' names the avoided lift");
  eq(classifyPain({ area: "shoulders", description: "a little sore" }).kind, "soreness", "'a little sore' is soreness");
}

// ── 3. the founder's fixture ─────────────────────────────────────────────────
const fx = JSON.parse(fs.readFileSync(join(here, "../tests/replay/founder-pain-fixture.json"), "utf8"));
const TZ = fx.tz;
const endOf = (d) => new Date(`${d}T23:30:00-04:00`);
const protectsOn = (d) => (d >= fx.program_from ? programPurpose(fx.program_text).protects : []);
// Replays the system forward day by day: whatever it said on a mention day gets
// stamped the way the chat post-parse code stamps it (noted_at always, offered_at
// on an offer). No athlete action is simulated.
function replayMarks(until) {
  let marks = {};
  const mentionDays = [...new Set(extractEvents(fx.rows, { tz: TZ }).filter((e) => e.type === "mention").map((e) => e.day))].sort();
  for (const d of mentionDays) {
    if (d > until) break;
    const recs = painStatus({ rows: fx.rows, marks, protects: protectsOn(d), now: endOf(d), tz: TZ });
    for (const r of recs) {
      if (!r.fresh) continue;
      if (r.speak === "offer_change_once") marks = withMark(marks, r.area, "offered_at", endOf(d));
      marks = withMark(marks, r.area, "noted_at", endOf(d));
    }
  }
  return marks;
}
const at = (d) => {
  const marks = replayMarks(d);
  const recs = painStatus({ rows: fx.rows, marks, protects: protectsOn(d), now: endOf(d), tz: TZ });
  const byArea = Object.fromEntries(recs.map((r) => [r.area, r]));
  return { recs, knee: byArea.knee, pec: byArea.pec, legs: byArea.legs, marks };
};
{
  // what the system SAID on each mention day (verdict before the day's stamp)
  const said = (d, area) => painStatus({ rows: fx.rows, marks: replayMarks(dayBefore(d)), protects: protectsOn(d), now: endOf(d), tz: TZ }).find((r) => r.area === area);
  function dayBefore(d) { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); }

  const a18 = at("2026-08-18");
  eq([a18.knee.state, a18.knee.trend], ["new", "steady"], "Aug 18 knee: new, steady");
  has(a18.knee.summary, "back Aug 17 after 9 weeks quiet", "Aug 18 knee summary names the return");
  eq(said("2026-08-17", "knee").speak, "acknowledge_once", "Aug 17 knee mention: acknowledge once");
  eq([a18.pec.state, a18.pec.trend], ["active", "steady"], "Aug 18 pec: active, steady");
  eq(said("2026-08-18", "pec").speak, "none", "Aug 18 pec (second mention, not worsening): tracked silently");
  has(a18.pec.summary, "back Jul 27 after 5 weeks quiet", "Aug 18 pec summary");

  const a25 = at("2026-08-25");
  eq([a25.knee.state, a25.knee.trend], ["active", "worsening"], "Aug 25 knee: active, worsening");
  eq(said("2026-08-25", "knee").speak, "offer_change_once", "Aug 25 knee: worsening pattern earns ONE offer");
  has(a25.knee.summary, "3 mentions in this stretch, 3 in the last 14 days", "Aug 25 knee summary counts");
  eq([a25.pec.state, a25.pec.trend], ["easing", "improving"], "Aug 25 pec: easing, improving (a clean incline session)");
  ok(a25.marks.knee && a25.marks.knee.offered_at, "Aug 25 offer stamped");

  const s01 = at("2026-09-01");
  eq([s01.knee.state, s01.knee.trend], ["active", "worsening"], "Sep 1 knee: active, worsening");
  eq(said("2026-09-01", "knee").speak, "none", "Sep 1 knee: already offered Aug 25, stays quiet (14-day cooldown)");
  has(s01.knee.summary, "5 mentions in this stretch, 4 in the last 14 days", "Sep 1 knee: 5 real mentions, not the 3 Joe claimed");
  eq([s01.pec.state, s01.pec.trend], ["easing", "improving"], "Sep 1 pec: easing");

  const s04 = at("2026-09-04");
  eq(s04.knee.state, "active", "Sep 4 knee: still active (3 days)");
  eq(s04.knee.trend, "steady", "Sep 4 knee: a clean 170 kg back squat stops the worsening read");
  eq(s04.knee.cleanSessionsSince, 1, "Sep 4 knee: one clean session");
  eq(s04.pec.state, "easing", "Sep 4 pec: easing");

  const s17 = at("2026-09-17");
  eq([s17.knee.state, s17.knee.trend], ["easing", "improving"], "Sep 17 knee: easing, improving");
  eq(s17.knee.addressedByProgram, true, "Sep 17 knee: Block 2 protects the knees");
  has(s17.knee.summary, "already works around it", "Sep 17 knee summary notes the program");
  eq(s17.pec.state, "cleared", "Sep 17 pec: cleared on its own (30 days, clean sessions)");
  eq(s17.legs, undefined, "Sep 17 'legs too sore' never enters the ledger");

  const s21 = at("2026-09-21");
  eq([s21.pec.state, s21.pec.trend], ["new", "steady"], "Sep 21 pec: new episode");
  has(s21.pec.summary, "back Sep 21 after 5 weeks quiet", "Sep 21 pec: back after 5 weeks quiet");
  eq(said("2026-09-21", "pec").speak, "acknowledge_once", "Sep 21 pec: acknowledge once");
  eq(s21.knee.state, "easing", "Sep 21 knee: easing");

  const s28 = at("2026-09-28");
  ok(["quiet", "cleared"].includes(s28.knee.state), `Sep 28 knee reads quiet or cleared with zero athlete action (got ${s28.knee.state})`);
  eq(s28.knee.trend, "improving", "Sep 28 knee improving");
  eq(s28.knee.cleanSessionsSince, 3, "Sep 28 knee: 3 clean squat sessions (Sep 4, 15, 25)");
  eq([s28.pec.state, s28.pec.trend], ["easing", "improving"], "Sep 28 pec: easing (85 lb incline clean)");
  eq(s28.knee.checkIn.tone, "cleared_yet", "Sep 28 check-in asks the knee 'has it cleared?'");
  eq(s28.knee.checkIn.askChange, false, "Sep 28: no protective-change question for knees");
  eq(s28.pec.checkIn.askChange, false, "Sep 28 pec easing: no protective-change question");
  for (const d of ["2026-08-18", "2026-08-25", "2026-09-01", "2026-09-04", "2026-09-17", "2026-09-21", "2026-09-28"]) {
    const { recs } = at(d);
    for (const r of recs) ok(!/[—]/.test(r.summary), `summary has no em dash (${d} ${r.area})`);
  }
}

// ── 4. gap hunters ───────────────────────────────────────────────────────────
const row = (day, flags, exercises, raw = "") => ({ id: `${day}-${Math.random().toString(36).slice(2, 6)}`, created_at: `${day}T16:00:00Z`, raw_message: raw, parsed_data: { pain_flags: flags, exercises: exercises || [] } });
const sq = (kg) => [{ name: "Back Squat", unit: "kg", weight: kg, sets: 3, reps: 3 }];
const st = (rows, d, extra = {}) => painStatus({ rows, now: endOf(d), tz: TZ, ...extra });
const one = (rows, d, area, extra) => st(rows, d, extra).find((r) => r.area === area);
{
  // two body parts in one message
  const rows = [row("2026-09-01", [{ area: "knees", description: "flared during squat" }, { area: "pec", description: "pec twinge on bench" }], sq(100))];
  const recs = st(rows, "2026-09-01");
  eq(recs.map((r) => r.area).sort(), ["knee", "pec"], "two areas, two records");
  ok(recs.every((r) => r.mentions === 1 && r.speak === "acknowledge_once"), "each is its own first mention");

  // report on day 1 and day 20: not a pattern
  const d20 = [row("2026-09-01", [{ area: "knee", description: "knee ache during squat" }], sq(100)), row("2026-09-20", [{ area: "knee", description: "knee ache during squat" }], sq(100))];
  const r20 = one(d20, "2026-09-20", "knee");
  ok(r20.speak !== "offer_change_once", "day 1 + day 20: no offer (not a pattern inside 14 days)");
  eq(r20.mentions14d, 1, "day 20: only one mention in the last 14 days");

  // serious language on a first report
  const ser = [row("2026-09-10", [{ area: "knee", description: "sharp pain and it gave out" }], sq(100))];
  const rs = one(ser, "2026-09-10", "knee");
  eq([rs.state, rs.speak], ["serious", "address_now"], "serious first report: address now");
  eq(rs.checkIn.tone, "serious", "serious check-in tone");

  // serious report in a dismissed area
  const rd = one(ser, "2026-09-10", "knee", { marks: { knee: { dismissed_at: "2026-09-02T12:00:00Z" } } });
  eq(rd.speak, "address_now", "serious in a dismissed area is still addressed");
  const dismissedMild = [row("2026-09-05", [{ area: "knee", description: "knee ache" }], sq(100))];
  const rdm = one(dismissedMild, "2026-09-06", "knee", { marks: { knee: { dismissed_at: "2026-09-05T20:00:00Z" } } });
  eq(rdm.checkIn.ask, false, "dismissed area: check-in stops asking");

  // pain in an area the program protects: worsening pattern, no offer
  const wors = [
    row("2026-09-01", [{ area: "knee", description: "a little knee ache during squat" }], sq(100)),
    row("2026-09-04", [{ area: "knee", description: "knee flared during squat" }], sq(100)),
    row("2026-09-07", [{ area: "knee", description: "knee on fire during squat, stopped" }], sq(100)),
  ];
  const rw = one(wors, "2026-09-07", "knee");
  eq([rw.trend, rw.speak], ["worsening", "offer_change_once"], "worsening pattern, unprotected: one offer");
  const rp = one(wors, "2026-09-07", "knee", { protects: ["knee"] });
  eq([rp.addressedByProgram, rp.speak], [true, "none"], "program already protects the knee: no offer");
  const rc = one(wors, "2026-09-07", "knee", { marks: { knee: { offered_at: "2026-09-04T12:00:00Z" } } });
  eq(rc.speak, "none", `offered ${OFFER_COOLDOWN_DAYS} days ago or less: quiet`);
  const rc2 = one(wors, "2026-09-07", "knee", { marks: { knee: { offered_at: "2026-08-20T12:00:00Z" } } });
  eq(rc2.speak, "offer_change_once", "offer older than the cooldown: may offer again");

  // "knee" then "left knee" then "knees"
  const kk = [row("2026-09-01", [{ area: "knee", description: "ache" }], sq(90)), row("2026-09-03", [{ area: "left knee", description: "ache" }], sq(90)), row("2026-09-05", [{ area: "knees", description: "ache" }], sq(90))];
  const rk = st(kk, "2026-09-05");
  eq(rk.length, 1, "knee / left knee / knees = one area");
  eq(rk[0].mentions, 3, "three mentions on one area");

  // soreness that is not pain
  eq(st([row("2026-09-01", [{ area: "legs", description: "legs are really sore from yesterday" }], sq(90))], "2026-09-01").length, 0, "soreness never enters the ledger");

  // athlete says "knee feels great now"
  const great = [row("2026-09-01", [{ area: "knee", description: "knee ache during squat" }], sq(100)), row("2026-09-04", [{ area: "knee", description: "knee feels great now", status: "cleared" }], sq(100))];
  eq(one(great, "2026-09-04", "knee").state, "cleared", "'knee feels great now' clears it");
  const great3 = [great[0], { ...row("2026-09-04", [], sq(100)), parsed_data: { pain_flags: [], pain_cleared: [{ area: "knee", description: "feels great now" }], exercises: sq(100) } }];
  eq(one(great3, "2026-09-04", "knee").state, "cleared", "parser pain_cleared field clears it");
  const great2 = [great[0], row("2026-09-04", [{ area: "knee", description: "knee feels great now" }], sq(100))];
  eq(one(great2, "2026-09-04", "knee").state, "cleared", "classifier reads 'feels great now' on an old row too");

  // resolved in MY LOG then flares a week later
  const flare = [row("2026-09-01", [{ area: "knees", description: "knee ache during squat" }], sq(100)), row("2026-09-10", [{ area: "knee", description: "knee flared on squats" }], sq(100))];
  const marks = { knee: { cleared_at: "2026-09-03T12:00:00Z" } };
  const rf = one(flare, "2026-09-10", "knee", { marks });
  eq([rf.state, rf.reopenedBy, rf.mentions], ["new", "cleared", 1], "flare after resolve reopens as a new episode");
  has(rf.summary, "after it had cleared", "summary says it came back after clearing");
  eq(one(flare.slice(0, 1), "2026-09-05", "knee", { marks }).state, "cleared", "before the flare it reads cleared");
  // legacy resolved_pain (no timestamp): cleared before today; a later event reopens
  eq(one(flare.slice(0, 1), "2026-09-05", "knee", { legacyResolved: ["knees"] }).state, "cleared", "legacy resolved string clears");
  const legacyNow = new Date("2026-09-10T08:00:00-04:00");
  const flareToday = [flare[0], { ...flare[1], created_at: "2026-09-10T14:00:00Z" }];
  const lm = normalizeMarks({}, ["knees"], { now: legacyNow, tz: TZ });
  const rl = painStatus({ rows: flareToday, marks: lm, now: endOf("2026-09-10"), tz: TZ }).find((r) => r.area === "knee");
  eq(rl.state, "new", "legacy resolved + pain event after the mark reopens the area");

  // six clean sessions with no mention
  const six = [row("2026-09-01", [{ area: "knee", description: "knee ache during back squat" }], sq(100))];
  for (let i = 0; i < 6; i++) six.push(row(`2026-09-0${2 + i}`, [], sq(100)));
  eq(one(six, "2026-09-07", "knee").state, "cleared", `${CLEARED_CLEAN} clean sessions: cleared`);
  eq(one(six.slice(0, 3), "2026-09-03", "knee").cleanSessionsSince, 2, "clean sessions counted");
  const light = [six[0], row("2026-09-02", [], sq(60)), row("2026-09-03", [], sq(60))];
  eq(one(light, "2026-09-03", "knee").cleanSessionsSince, 0, "sessions under 85% of the hurt load are not evidence");

  // a chat row with a pain flag but no workout
  const chatOnly = [{ id: "c1", created_at: "2026-09-01T16:00:00Z", raw_message: "my shoulder is barking", parsed_data: { pain_flags: [{ area: "shoulder", description: "barking" }] } }];
  const rco = one(chatOnly, "2026-09-01", "shoulder");
  ok(rco && rco.mentions === 1, "chat row pain counts as a mention");

  // episode gap
  const gap = [row("2026-07-01", [{ area: "hip", description: "hip ache" }], []), row("2026-08-15", [{ area: "hip", description: "hip ache" }], [])];
  const rg = one(gap, "2026-08-15", "hip");
  eq([rg.state, rg.gapBefore >= EPISODE_GAP_DAYS], ["new", true], "28+ quiet days opens a new episode");
  has(rg.summary, "after 6 weeks quiet", "summary: back after N weeks quiet");

  // check-in: two declines stop the change question, not the status question
  const two = one(wors, "2026-09-07", "knee", { marks: { knee: { declined_change_count: 2 } } });
  eq([two.checkIn.ask, two.checkIn.askChange], [true, false], "two declines stop the change question only");
  eq(one(six, "2026-09-07", "knee").checkIn.ask, false, "cleared area: check-in stops asking");

  // nextMention
  eq(NEXT_MENTION_DEFAULT.same, "acknowledge_once", "no history: acknowledge once");
  eq(rw.nextMention.serious, "address_now", "serious language is always address_now");
  const nm = one(wors.slice(0, 2), "2026-09-05", "knee");
  eq(nm.nextMention.same, "offer_change_once", "a third, worse mention would earn the offer");
  eq(nm.nextMention.milder, "none", "a milder third mention is tracked silently");

  // pre-turn read
  const pt = preTurnPain("felt a pop in my knee and it gave out on the squat");
  eq([pt.serious, pt.areas], [true, ["knee"]], "pre-turn: serious knee");
  eq(preTurnPain("knees a bit tight today").serious, false, "pre-turn: tight is not serious");
  eq(preTurnPain("I feel sharp today, great session").serious, false, "pre-turn: no area, not serious");

  // block
  const blk = ledgerBlock(st(wors, "2026-09-07"), { protects: ["knee"], turn: pt });
  has(blk, "PAIN LEDGER", "block header");
  has(blk, "never count mentions", "block forbids counting");
  has(blk, "The app will stage a protective program rec", "serious turn tells Joe a rec is coming");
  ok(!/Noted\. One rough day/.test(blk), "no rote 'one rough day' line");
  ok(!/[—]/.test(blk), "block has no em dash");

  // withMark is pure
  const m0 = { knee: { offered_at: "x" } };
  const m1 = withMark(m0, "knees", "noted_at", new Date("2026-09-01T00:00:00Z"));
  eq(m0.knee.noted_at, undefined, "withMark does not mutate");
  eq(m1.knee.noted_at, "2026-09-01T00:00:00.000Z", "withMark stamps");
  eq(withMark(withMark({}, "pec", "declined_change"), "pec", "declined_change").pec.declined_change_count, 2, "declines count");
  eq(dayKey("2026-08-22T04:21:26Z", TZ), "2026-08-22", "day keys use the athlete's tz");
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
