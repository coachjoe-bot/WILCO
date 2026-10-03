// ─── ATHLETE CONTEXT: THE LINES THE TAB COMPUTES (T69-C) ─────────────────────
// Body (pain from the ledger, the lifts it limits, maxes in the unit they were
// logged in, limiters), Preferences (typed prefs, units per lift), Goal progress
// and This week (the proof brief's numbers, client-side). The founder's real
// pain rows are the fixture (tests/replay/founder-pain-fixture.json).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { painStatus } from "../src/painLedger.js";
import { painTabLines, painLimits, maxesTab, limiterLines, prefsLines, unitsByLift, goalProgressLines, thisWeekTab, thisWeekLines, checkedLabel } from "../src/contextLines.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } };
const fx = JSON.parse(fs.readFileSync(join(here, "../tests/replay/founder-pain-fixture.json"), "utf8"));
const TZ = fx.tz;
const NOW = new Date("2026-09-29T16:00:00Z");

console.log("pain lines are the ledger's own records:");
const recs = painStatus({ rows: fx.rows, marks: {}, legacyResolved: [], now: NOW, tz: TZ });
const lines = painTabLines({ records: recs, rows: fx.rows, notes: [], unit: "kg", tz: TZ });
const pec = lines.find((l) => l.area === "pec"), knee = lines.find((l) => l.area === "knee");
ok(!!pec && !!knee, "the founder has pec and knee records");
ok(pec && /pec/i.test(pec.label) && /last mentioned Sep 2[0-9]/.test(pec.head), `pec line names the last mention (${pec && pec.head})`);
ok(knee && /^Knee/i.test(knee.label) && (/cleared|quiet|easing|open|active/.test(knee.head)), `knee line carries its state (${knee && knee.head})`);
ok(lines.every((l) => /^Tracked, /.test(l.chip)), "every pain line is chipped Tracked with a date");
ok(lines.every((l) => !/—|–/.test(l.head + l.sub)), "no em dashes");
ok(pec && /It hurt on/.test(pec.sub), `under the pec: where it hurt (${pec && pec.sub})`);
ok(pec && /pain-free since, up to/.test(pec.sub) && /incline/i.test(pec.sub), `and the lift trained pain-free since, with its top load (${pec && pec.sub})`);
ok(pec && /\b(kg|lbs)\b/.test(pec.sub), "in the unit it was logged in");
const lim = painLimits(recs.find((r) => r.area === "pec"), fx.rows, { unit: "kg", tz: TZ });
ok(lim.hurt && lim.hurt.day === recs.find((r) => r.area === "pec").lastAt, "painLimits.hurt is the ledger's lastDuring on the last mention day");

console.log("a work-around note is tied to its area:");
const wk = { id: "wk1", content: "Working around it: incline DB press in place of bench", status: "active", area_key: "pec" };
const withWork = painTabLines({ records: recs, rows: fx.rows, notes: [wk, { id: "x", content: "other", status: "active" }], unit: "kg", tz: TZ });
ok(withWork.find((l) => l.area === "pec").workaround.id === "wk1", "the pec line carries the work-around");
ok(!withWork.find((l) => l.area === "knee").workaround, "other areas do not");

console.log("cleared by the athlete's own mark:");
const marked = painStatus({ rows: fx.rows, marks: { pec: { cleared_at: "2026-09-29T15:00:00Z" } }, legacyResolved: [], now: NOW, tz: TZ });
const mp = marked.find((r) => r.area === "pec");
ok(mp.state === "cleared" && mp.clearedOn === "2026-09-29", `the ledger now says WHEN it cleared (${mp.clearedOn})`);
ok(painTabLines({ records: marked, rows: fx.rows, unit: "kg", tz: TZ }).find((l) => l.area === "pec").cleared, "the tab line reads cleared");

console.log("maxes in the unit they were logged in:");
const ex = (name, weight, unit, reps = 3) => ({ name, sets: 3, reps, weight, unit });
const row = (days, exercises, over = {}) => ({ id: `w${days}${exercises[0].name}`, created_at: new Date(NOW.getTime() - days * 864e5).toISOString(), parsed_data: { exercises }, ...over });
const rows = [
  row(3, [ex("Back Squat", 160, "kg"), ex("Bench Press", 225, "lbs", 3)]),
  row(5, [ex("Front Squat", 120, "kg"), ex("Clean & Jerk", 125, "kg", 1)]),
  row(9, [ex("Snatch", 100, "kg", 1)]),
];
const mx = maxesTab({ rows, manualRMs: [], bodyweightLbs: 185, unit: "kg" });
ok(/Back squat \d+(\.\d)? kg/.test(mx.line), `a kg lift reads kg (${mx.line})`);
ok(/Bench press \d+ lbs/.test(mx.line), `the lbs bench stays lbs on a kg account (${mx.line})`);
ok(!/\(\d+ lbs\)/.test(mx.line), "never two units for one lift");
const mx2 = maxesTab({ rows, manualRMs: [{ exercise: "Back Squat", weight: 200, unit: "kg" }], bodyweightLbs: 185, unit: "kg" });
ok(/Back squat 200 kg/.test(mx2.line), "an actual 1RM replaces the estimate");

console.log("limiters, in words the athlete reads:");
const lm = limiterLines({ rows: [row(2, [ex("Back Squat", 180, "kg", 1), ex("Front Squat", 120, "kg", 1), ex("Clean & Jerk", 110, "kg", 1)])], manualRMs: [], bodyweightLbs: 185 });
ok(lm.length >= 1 && lm.every((l) => /is \d+% of your .* \(\d+ to \d+ is typical\)\. That is /.test(l)), `plain sentences (${lm[0]})`);
ok(lm.every((l) => !/—|–|limiter|ratio/i.test(l)), "no coach shorthand");

console.log("preferences:");
ok(prefsLines(null).length === 0, "an all-default athlete has no pref lines");
ok(prefsLines({ session_minutes_cap: 75 }).some((l) => /75/.test(l)), "a typed cap shows");
ok(unitsByLift(rows, { unit: "kg" }) === "You log back squat, front squat, clean & jerk, snatch in kg and bench press in lbs." || /in kg and .*in lbs/.test(unitsByLift(rows, { unit: "kg" })), `mixed units: ${unitsByLift(rows, { unit: "kg" })}`);
ok(unitsByLift([row(1, [ex("Back Squat", 100, "kg")])], { unit: "kg" }) === "You log in kg.", "one unit says so once");
ok(unitsByLift([], { unit: "kg" }) === "", "nothing logged, no line");

console.log("goal progress:");
const g = { goal_text: "Bench 315 and squat 405", parsed_targets: [{ lift: "bench press", target_lbs: 315 }, { lift: "back squat", target_lbs: 405 }] };
const gp = goalProgressLines(g, mx.items, { unit: "lbs" });
ok(gp.length === 2 && /Bench press 315 lbs: you are at \d+ lbs\./.test(gp[0]), `a line per measurable target (${gp[0]})`);
ok(goalProgressLines({ goal_text: "get strong" }, mx.items).length === 0, "no number in the goal, no progress line");

console.log("this week (the brief's numbers, computed client-side):");
const wkRows = [row(1, [ex("Back Squat", 150, "kg")]), row(2, [ex("Bench Press", 200, "lbs")]), row(9, [ex("Back Squat", 140, "kg")]), row(10, [ex("Snatch", 90, "kg", 2)]), row(12, [ex("Back Squat", 140, "kg")])];
const prog = "Day 1 - Squat\nBack Squat 4x5\nPull-ups 3x8\nDay 2 - Bench\nBench Press 3x5\nRows 3x10\n";
const tw = thisWeekTab({ rows: wkRows, athlete: { training_days_per_week: 4 }, prs: [{ exercise: "Bench Press", weight: 205, unit: "lbs", reps: 1, date: new Date(NOW.getTime() - 86400000).toISOString() }], programText: prog, now: NOW });
ok(tw.sessions === 2 && tw.lastSessions === 3, `sessions this week and last (${tw.sessions}, ${tw.lastSessions})`);
ok(tw.sets === 6 && tw.lastSets === 9, `set volume (${tw.sets}, ${tw.lastSets})`);
ok(tw.notLogged.includes("pull-ups") && tw.notLogged.includes("rows") && !tw.notLogged.some((n) => /squat|bench/.test(n)), `planned and not logged (${tw.notLogged})`);
ok(tw.prs.length === 1, "a PR in the window");
const tl = thisWeekLines(tw, { position: null });
ok(/^2 of 4 sessions \(3 last week\), 6 sets \(9 last week\)$/.test(tl[0]), `the line reads as a sentence (${tl[0]})`);
ok(tl.some((l) => /^Not logged yet: /.test(l)) && tl.some((l) => /^PR: bench press 205 lbs/.test(l)), "not-logged and PR lines");
ok(tl.every((l) => !/—|–/.test(l)), "no em dashes");
ok(thisWeekTab({ rows: [], athlete: {}, now: NOW }).sessions === 0, "a brand-new athlete: zeros, no crash");

console.log("stamps:");
ok(checkedLabel({ confirmed_at: "2026-10-04T12:00:00Z" }) === "Checked Oct 4", "checked date");
ok(checkedLabel({ created_at: "2026-09-02T12:00:00Z" }) === "Saved Sep 2", "never checked: when it was saved");
ok(checkedLabel({}) === "", "nothing to say");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
