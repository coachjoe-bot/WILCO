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

// ─── background pre-build: the cost gate ─────────────────────────────────────
// Every case here is money. A pre-build the athlete never opens is a wasted Sonnet
// call, so the gates that REFUSE to generate matter more than the one that allows it.
const { qlMarkUsed, qlPrebuildEligible, qlMarkPrebuilt, qlLocalDay, QL_PREBUILD_WINDOW_MS } = await import("../src/quicklog.js");

reset();
check("never used Quick Log → no speculative call", qlPrebuildEligible(ATH) === false);
qlMarkUsed(ATH);
check("recent Quick Log user → eligible", qlPrebuildEligible(ATH) === true);
qlMarkPrebuilt(ATH);
check("one pre-build per day, not per app open", qlPrebuildEligible(ATH) === false);
// The stamp is a LOCAL day (a UTC one rolls over mid-evening and buys a second call).
check("day stamp is the local date", qlLocalDay(Date.now()) === new Date().toLocaleDateString());
reset();
store.set(`wilco_quicklog_used_${ATH}`, String(Date.now()));
store.set(`wilco_quicklog_prebuilt_${ATH}`, new Date(Date.now()-36*60*60*1000).toLocaleDateString());
check("yesterday's stamp doesn't block today", qlPrebuildEligible(ATH) === true);
reset();
store.set(`wilco_quicklog_used_${ATH}`, String(Date.now() - (QL_PREBUILD_WINDOW_MS + 1000)));
check("lapsed user (>14d) → no speculative call", qlPrebuildEligible(ATH) === false);
reset();
store.set(`wilco_quicklog_used_${ATH}`, "garbage");
check("corrupt usage stamp → no speculative call", qlPrebuildEligible(ATH) === false);
check("pre-build eligibility is per athlete", (()=>{ reset(); qlMarkUsed("a"); return qlPrebuildEligible("a")===true && qlPrebuildEligible("b")===false; })());

// A pre-built draft must not masquerade as the athlete's own unfinished work.
reset();
qlSave(ATH, HIST, {draft:"Upper A\nBench 5x5 225", notes:"n", prebuilt:true});
check("pre-built flag round trips", qlLoad(ATH, HIST).prebuilt === true);
qlSave(ATH, HIST, {draft:"Upper A\nBench 5x5 235", notes:"n"});
check("saving from the sheet clears the pre-built flag", qlLoad(ATH, HIST).prebuilt === false);

// ─── the "===" reply splitter ────────────────────────────────────────────────
// Three call sites parse this (draft, edit, streaming draft). A missed separator
// dumps Joe's coaching prose into the workout log, where the chat parser reads it
// as exercises — so the shape of the reply, not just the storage, gets covered.
const { splitQuickLogReply, streamQuickLogReply } = await import("../src/quicklog.js");

const TWO = "Heavy bench day.\nClimbs to 89% of your 275.\n===\nUpper A\nBench 5x5 225";
let s = splitQuickLogReply(TWO);
check("splits the focus note off the log", s.notes === "Heavy bench day.\nClimbs to 89% of your 275." && s.log === "Upper A\nBench 5x5 225");
check("no separator → notes is NULL, not empty", splitQuickLogReply("Upper A\nBench 5x5 225").notes === null);
check("no separator → the whole reply is the log", splitQuickLogReply("Upper A").log === "Upper A");
// The distinction above is load-bearing: the edit path keeps its existing note when
// notes===null and replaces it when notes==="".
check("an explicitly EMPTY note is not null", splitQuickLogReply("\n===\nUpper A").notes === "");
check("a longer rule still splits", splitQuickLogReply("note\n=========\nlog").log === "log");
check("padded separator still splits", splitQuickLogReply("note\n   ====   \nlog").log === "log");
// A second separator is a formatting artifact, not content — the log keeps both
// halves joined by a newline (unchanged from the original inline parser).
check("a second separator is dropped, its text kept", splitQuickLogReply("note\n===\nlog a\n===\nlog b").log === "log a\nlog b");
check("a bare == is NOT a separator", splitQuickLogReply("note\n==\nlog").notes === null);
check("inline === is not a separator", splitQuickLogReply("do 3x5 === hard").notes === null);
check("empty input is safe", splitQuickLogReply("").log === "" && splitQuickLogReply(undefined).log === "");

// Streaming: before the separator lands, everything so far is the focus note.
check("mid-note stream shows note, empty log", (()=>{const r=streamQuickLogReply("Heavy bench day.");return r.notes==="Heavy bench day."&&r.log===""&&!r.complete;})());
check("a partial separator is trimmed off the note", streamQuickLogReply("Heavy bench day.\n==").notes === "Heavy bench day.");
check("stream after the separator fills the log", (()=>{const r=streamQuickLogReply(TWO);return r.complete&&r.log==="Upper A\nBench 5x5 225";})());
check("empty stream is safe", streamQuickLogReply("").notes === "");

console.log(`\n${fail===0?"✓":"✗"} quick log draft: ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
