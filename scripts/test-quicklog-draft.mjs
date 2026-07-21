// Quick Log draft-persistence regression suite — the guard rail for src/quicklog.js.
// Run with: node scripts/test-quicklog-draft.mjs
//
// What's actually at stake: a parked draft that survives when it shouldn't gets the
// athlete to send a workout they already logged. So the rules that THROW DRAFTS AWAY
// (the 8h window, the history stamp) matter more than the ones that keep them, and get
// the most cases here. When a resume bug shows up: add the case, watch it fail, fix
// quicklog.js, watch it pass.

// Minimal localStorage stand-in — the module only ever uses these three methods.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { qlKey, qlStamp, qlLoad, qlSave, qlClear, QL_RESUME_MS } = await import("../src/quicklog.js");

let pass = 0, fail = 0;
const check = (name, cond) => { if(cond){ pass++; } else { fail++; console.log(`  ✗ ${name}`); } };
const reset = () => store.clear();

const ATH = "ath-1";
const HIST = [{id:"w9", created_at:"2026-07-21T14:00:00Z"}, {id:"w8"}];
const DRAFT = {draft:"Upper A\nBench 185x5", notes:"Focus: bar speed", undoStack:[{draft:"x",notes:""}]};

// ─── round trip ──────────────────────────────────────────────────────────────
reset();
qlSave(ATH, HIST, DRAFT);
const got = qlLoad(ATH, HIST);
check("round trip returns the draft", got && got.draft === DRAFT.draft);
check("round trip returns the focus note", got && got.notes === DRAFT.notes);
check("round trip returns the undo stack", got && got.undoStack.length === 1);
check("nothing saved → nothing to resume", qlLoad("someone-else", HIST) === null);

// Athletes don't share a draft — two accounts on one phone (Will has exactly this).
reset();
qlSave("ath-A", HIST, DRAFT);
check("draft is scoped per athlete", qlLoad("ath-B", HIST) === null);

// ─── the rules that throw drafts away ────────────────────────────────────────
reset();
qlSave(ATH, HIST, DRAFT);
qlClear(ATH);
check("clear (what send does) leaves nothing to resume", qlLoad(ATH, HIST) === null);

// Expiry. Written by hand so we control savedAt rather than mocking the clock.
const writeAged = (ageMs, stamp) => {
  store.set(qlKey(ATH), JSON.stringify({...DRAFT, savedAt: Date.now()-ageMs, stamp: stamp ?? qlStamp(HIST)}));
};
reset(); writeAged(30*60*1000);
check("30 min old still resumes (came back between sets)", qlLoad(ATH, HIST) !== null);
reset(); writeAged(QL_RESUME_MS - 60*1000);
check("just inside the window resumes", qlLoad(ATH, HIST) !== null);
reset(); writeAged(QL_RESUME_MS + 60*1000);
check("just past the window is gone", qlLoad(ATH, HIST) === null);
reset(); writeAged(26*60*60*1000);
check("yesterday's draft never comes back", qlLoad(ATH, HIST) === null);

// Staleness — they logged through chat while the draft sat parked. THE double-log guard.
reset(); qlSave(ATH, HIST, DRAFT);
check("a new session logged since → draft dropped", qlLoad(ATH, [{id:"w10"},...HIST]) === null);
reset(); qlSave(ATH, [], DRAFT);
check("first-ever log lands while parked → draft dropped", qlLoad(ATH, [{id:"w1"}]) === null);

// ...but an in-place correction (same rows, edited parsed_data) must NOT nuke their work.
reset(); qlSave(ATH, HIST, DRAFT);
const corrected = HIST.map(w => w.id==="w9" ? {...w, parsed_data:{fixed:true}} : w);
check("a log correction leaves the draft resumable", qlLoad(ATH, corrected) !== null);

// ─── junk in, null out (never an error in front of someone mid-workout) ──────
reset(); qlSave(ATH, HIST, {draft:"   ", notes:"", undoStack:[]});
check("a whitespace-only draft is not resumable", qlLoad(ATH, HIST) === null);
reset(); qlSave(ATH, HIST, DRAFT); qlSave(ATH, HIST, {draft:"", notes:"", undoStack:[]});
check("emptying the textarea clears the parked draft", store.has(qlKey(ATH)) === false);
reset(); store.set(qlKey(ATH), "{not json");
check("corrupt payload → null, no throw", qlLoad(ATH, HIST) === null);
reset(); store.set(qlKey(ATH), JSON.stringify({draft:42, savedAt:Date.now(), stamp:qlStamp(HIST)}));
check("wrong-typed draft → null, no throw", qlLoad(ATH, HIST) === null);
reset(); store.set(qlKey(ATH), JSON.stringify({draft:"Upper A", stamp:qlStamp(HIST)}));
check("missing savedAt is treated as expired", qlLoad(ATH, HIST) === null);
reset(); store.set(qlKey(ATH), JSON.stringify({draft:"Upper A", savedAt:Date.now(), stamp:qlStamp(HIST), notes:null, undoStack:"nope"}));
const salvaged = qlLoad(ATH, HIST);
check("bad notes/undoStack degrade to empty, draft survives", salvaged && salvaged.notes==="" && salvaged.undoStack.length===0);

// A blown localStorage quota (Safari private mode) must not take the sheet down with it.
reset();
const realSet = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
let threw = false;
try{ qlSave(ATH, HIST, DRAFT); }catch(_){ threw = true; }
globalThis.localStorage.setItem = realSet;
check("a storage failure is swallowed, not thrown", threw === false);

// ─── stamp ───────────────────────────────────────────────────────────────────
check("empty history has a stable stamp", qlStamp([]) === qlStamp([]));
check("undefined history doesn't crash the stamp", typeof qlStamp(undefined) === "string");
check("history without ids still fingerprints", qlStamp([{created_at:"2026-07-21"}]) !== qlStamp([]));

console.log(`\n${fail===0?"✓":"✗"} quick log draft: ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
