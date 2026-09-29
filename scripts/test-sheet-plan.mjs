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
const { sheetRegenPlan, isPlainStart, asksFreshSheet } = await import("../src/sheetPlan.js");

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

// Their sheet, and a turn that changes nothing about the session.
check("prefill on a plain start: keep", plan({rec:mine, reason:"prefill", msg:"starting my workout"}) === "keep");
check("prefill from a button tap (no message): keep", plan({rec:mine, reason:"prefill", msg:""}) === "keep");
check("prefill, what's my workout today: keep", plan({rec:mine, reason:"prefill", msg:"what's my workout today"}) === "keep");
check("prefill, the sheet's own day named: keep", plan({rec:mine, reason:"prefill", msg:"starting my workout", position:{week:3, day:2}}) === "keep");
check("card refresh: keep", plan({rec:mine, reason:"pin", msg:"put it on my lock screen"}) === "keep");
check("'I'm on day 2' (the sheet's day): keep", plan({rec:mine, reason:"position", msg:"I'm on day 2", position:{week:3, day:2}}) === "keep");
check("a position the app cannot place: keep (an unknown never destroys work)", plan({rec:mine, reason:"position", msg:"I'm on the next one", position:{week:null, day:null}}) === "keep");
check("no position handed over: keep", plan({rec:mine, reason:"position", msg:"I'm on day 2"}) === "keep");

// Their sheet, and a turn that changes the session: applied to THEIR text.
check("in-chat swap: edit", plan({rec:mine, reason:"swap", msg:"subbed dips for pushdowns"}) === "edit");
check("prefill + a today-only change: edit", plan({rec:mine, reason:"prefill", msg:"no barbell today, give me a dumbbell version"}) === "edit");
check("prefill + start with a condition in the same breath: edit", plan({rec:mine, reason:"prefill", msg:"starting my workout but the rack is taken"}) === "edit");
check("prefill + start with a swap: edit", plan({rec:mine, reason:"prefill", msg:"start my workout, swap squats for leg press"}) === "edit");
check("prefill + anything the readers do not know: edit (the edit call returns the draft unchanged when it is not an edit)", plan({rec:mine, reason:"prefill", msg:"make today lighter"}) === "edit");

// Their sheet, and a different session asked for: the one time it is replaced.
check("a DIFFERENT day on prefill: generate", plan({rec:mine, reason:"prefill", msg:"starting my workout", position:{week:3, day:4}}) === "generate");
check("'I'm actually on day 4': generate", plan({rec:mine, reason:"position", msg:"I'm actually on day 4", position:{week:3, day:4}}) === "generate");
check("a different WEEK: generate", plan({rec:mine, reason:"position", msg:"I'm in week 4", position:{week:4, day:2}}) === "generate");
check("a day change outranks a card refresh", plan({rec:mine, reason:"pin", msg:"", position:{week:3, day:5}}) === "generate");
check("Different Workout button: generate", plan({rec:mine, reason:"switch", msg:"upper B"}) === "generate");
check("'start the sheet over': generate", plan({rec:mine, reason:"prefill", msg:"start the sheet over"}) === "generate");
check("'start fresh' on a swap turn: generate", plan({rec:mine, reason:"swap", msg:"swap it all, start fresh"}) === "generate");

// The readers.
for(const m of ["starting my workout", "start my workout", "about to start my session", "what's my workout today", "show me today's session"])
  check(`plain start: "${m}"`, isPlainStart(m) === true);
// "gym" is one of the condition words, so this goes to the edit call, which
// leaves the draft alone. Pinned so nobody is surprised by it.
check(`"I'm at the gym" is not a plain start (condition word)`, isPlainStart("I'm at the gym") === false);
for(const m of ["starting my workout but no barbell today", "start my workout, swap squats for leg press", "what's my squat max", "my knee hurts", "I did 5 sets instead of 4", "", null, undefined])
  check(`not a plain start: "${m}"`, isPlainStart(m) === false);
for(const m of ["start over", "start the sheet over", "starting fresh", "reset the log", "redo it from scratch", "rebuild the workout", "clear my sheet"])
  check(`asks fresh: "${m}"`, asksFreshSheet(m) === true);
for(const m of ["starting my workout", "fresh legs today", "I reset my grip", "start my workout", "", null])
  check(`does not ask fresh: "${m}"`, asksFreshSheet(m) === false);

console.log(`\n${fail===0?"✓":"✗"} sheet plan: ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
