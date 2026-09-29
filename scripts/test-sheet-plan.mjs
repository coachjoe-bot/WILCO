// The sheet and the generators: the guard rail for src/sheetPlan.js.
// Run with: node scripts/test-sheet-plan.mjs
//
// At stake: a generator writing a clean draft over a sheet the athlete has
// changed (Will, TestFlight, 09-29), and the opposite failure, a sheet that
// refuses to move when the athlete really did ask for a different session.

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { qlSave, qlLoad, qlEdit, qlSetDock } = await import("../src/quicklog.js");
const { sheetRegenPlan, asksFreshSheet, sheetFactLine, namedPositionSince } = await import("../src/sheetPlan.js");

let pass = 0, fail = 0;
const check = (name, cond) => { if(cond){ pass++; } else { fail++; console.log(`  ✗ ${name}`); } };

const ATH = "ath-1", HIST = [{id:"w9"}];
const GEN = {draft:"Day 2\n\nFront Squat 4x2 @ 120kg", notes:"Focus: fast elbows", undoStack:[], prebuilt:true, position:{week:3, day:2}};
qlSave(ATH, HIST, GEN); qlSetDock(ATH, true);
const untouched = qlLoad(ATH, HIST);
qlEdit(ATH, HIST, {draft:"Day 2\n\nFront Squat 4x2 @ 100kg/110kg/120kg/120kg"});
const mine = qlLoad(ATH, HIST);
const plan = sheetRegenPlan;

check("fixture: the untouched park is the app's", untouched.prebuilt === true);
check("fixture: the edited park is the athlete's", mine.prebuilt === false);

// Nothing of theirs to protect: every path behaves as it always has.
check("no park: generate", plan({rec:null, reason:"prefill", msg:"starting my workout"}) === "generate");
check("no arguments at all: generate, no throw", plan() === "generate");
for(const reason of ["prefill","pin","swap","position","switch"])
  check(`untouched draft + ${reason}: generate`, plan({rec:untouched, reason, msg:"subbed dips for pushdowns", position:{week:3, day:2}}) === "generate");

// Their sheet: nothing said in chat rewrites it.
const CHAT = [
  "starting my workout", "", "what's my workout today", "bring my log back up",
  "Starting my workoutstar",                                  // the simulator's mistyped start, 09-29: this one reached the edit call and lost a lift
  "no barbell today, give me a dumbbell version", "starting my workout but the rack is taken",
  "start my workout, swap squats for leg press", "subbed dips for pushdowns", "make today lighter",
  "I had to start over on my second set", "starting fresh today, feeling good", "my knee hurts",
  "put it on my lock screen", "I'm at the gym",
];
for(const reason of ["prefill","pin","swap","position"])
  for(const msg of CHAT)
    check(`their sheet + ${reason} + "${msg}": keep`, plan({rec:mine, reason, msg}) === "keep");
check("the only answers are generate and keep", ["prefill","pin","swap","position","switch"].every(reason => CHAT.every(msg => ["generate","keep"].includes(plan({rec:mine, reason, msg, position:{week:3, day:2}})))));
check("the sheet's own day named: keep", plan({rec:mine, reason:"position", msg:"I'm on day 2", position:{week:3, day:2}}) === "keep");
check("a position the app cannot place: keep (an unknown never destroys work)", plan({rec:mine, reason:"position", msg:"I'm on the next one", position:{week:null, day:null}}) === "keep");
check("a sheet that never recorded its position: keep", plan({rec:{...mine, position:null}, reason:"position", msg:"I'm on day 4", position:{week:3, day:4}}) === "keep");

// Their sheet, and a different session or a clean sheet asked for: replaced.
check("a DIFFERENT day on prefill: generate", plan({rec:mine, reason:"prefill", msg:"starting my workout", position:{week:3, day:4}}) === "generate");
check("'I'm actually on day 4': generate", plan({rec:mine, reason:"position", msg:"I'm actually on day 4", position:{week:3, day:4}}) === "generate");
check("a different WEEK: generate", plan({rec:mine, reason:"position", msg:"I'm in week 4", position:{week:4, day:2}}) === "generate");
check("a day change outranks a card refresh", plan({rec:mine, reason:"pin", msg:"", position:{week:3, day:5}}) === "generate");
check("Different Workout button: generate", plan({rec:mine, reason:"switch", msg:"upper B"}) === "generate");
check("'start the sheet over': generate", plan({rec:mine, reason:"prefill", msg:"start the sheet over"}) === "generate");

// Only a session THEY named, after the sheet was last touched, moves it.
{
  const saved = mine.savedAt;
  const iso = (ms) => new Date(ms).toISOString();
  check("the park reports when it was last written", Number.isFinite(saved) && saved > 0);
  check("named after the last edit: counts", JSON.stringify(namedPositionSince({week:3, day:4, at:iso(saved+60000)}, saved)) === JSON.stringify({week:3, day:4}));
  check("named BEFORE the last edit: does not (their later typing wins)", namedPositionSince({week:3, day:4, at:iso(saved-60000)}, saved) === null);
  check("named at the same instant: does not", namedPositionSince({week:3, day:4, at:iso(saved)}, saved) === null);
  check("a day with no week still counts", JSON.stringify(namedPositionSince({day:4, at:iso(saved+1)}, saved)) === JSON.stringify({week:null, day:4}));
  check("no override: null", namedPositionSince(null, saved) === null && namedPositionSince(undefined, saved) === null);
  check("an override with no timestamp: null", namedPositionSince({week:3, day:4}, saved) === null);
  check("a garbage timestamp: null", namedPositionSince({week:3, day:4, at:"soon"}, saved) === null);
  check("an empty override: null", namedPositionSince({at:iso(saved+1)}, saved) === null);
  // The drift case: a lift logged in chat mid-workout moves the resolver to the
  // next day. They named nothing, so the sheet stays.
  check("resolver drift with nothing named: keep", plan({rec:mine, reason:"prefill", msg:"starting my workout", position:namedPositionSince({week:3, day:2, at:iso(saved-3600000)}, saved)}) === "keep");
  check("they named day 4 after editing: generate", plan({rec:mine, reason:"prefill", msg:"starting my workout", position:namedPositionSince({week:3, day:4, at:iso(saved+1000)}, saved)}) === "generate");
  check("they named the sheet's own day after editing: keep", plan({rec:mine, reason:"position", msg:"I'm on day 2", position:namedPositionSince({week:3, day:2, at:iso(saved+1000)}, saved)}) === "keep");
}

// The one reader. It replaces the athlete's work, so it must name the sheet.
for(const m of ["start the sheet over", "reset the log", "reset my log sheet", "redo the sheet", "rebuild the log", "clear my sheet", "give me a fresh sheet", "new log sheet please", "wipe the sheet", "start the log over"])
  check(`asks fresh: "${m}"`, asksFreshSheet(m) === true);
for(const m of ["start over", "I had to start over on my second set", "starting fresh today", "fresh legs today", "I reset my grip", "start my workout", "starting my workout", "redo that last set", "rebuild my squat", "from scratch", "clear the bar", "log this", "new PR", "", null, undefined])
  check(`does not ask fresh: "${m}"`, asksFreshSheet(m) === false);

// The fact Joe is handed.
check("fact: their started sheet gets the line", /LOG SHEET/.test(sheetFactLine(mine)));
check("fact: an untouched sheet gets nothing", sheetFactLine(untouched) === "");
check("fact: their sheet with the bar down gets nothing", sheetFactLine({...mine, dock:false}) === "");
check("fact: no park gets nothing", sheetFactLine(null) === "");
check("fact: no em dash, no tool names", !/—|prefill_log_sheet|pin_session_card/.test(sheetFactLine(mine)));

console.log(`\n${fail===0?"✓":"✗"} sheet plan: ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
