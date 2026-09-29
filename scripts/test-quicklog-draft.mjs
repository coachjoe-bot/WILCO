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

const { qlKey, qlStamp, qlLoad, qlSave, qlClear, qlPositionConflict, QL_RESUME_MS,
        qlStampHead, qlStampMatches, qlPeek, qlEdit, qlSetDock, qlSetSheetDate, qlRestamp,
        qlResumeDock,
        openerLoad, openerSave,
        looksLikeProgramText, findChatProgram, programSaveOfferAllowed, markProgramSaveOffered,
        QL_PROGRAM_OFFER_MAX, markSupersededPrograms, QL_SUPERSEDED,
        parseRequestedDate, QL_MAX_BACKDATE_DAYS } = await import("../src/quicklog.js");

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
// Past the rolling window, an athlete's OWN draft additionally survives its local
// calendar day (Will edited a workout at the gym and lost it an hour later — an
// edited draft persists until sent, discarded, or genuinely a different day). A
// PREBUILT draft gets no same-day grace: nothing is lost by regenerating it.
reset(); store.set(qlKey(ATH), JSON.stringify({...DRAFT, savedAt: new Date().setHours(0,5,0,0), stamp: qlStamp(HIST)}));
check("an edited draft from early this morning resumes all day", qlLoad(ATH, HIST) !== null);
reset(); store.set(qlKey(ATH), JSON.stringify({...DRAFT, prebuilt:true, savedAt: Date.now()-(QL_RESUME_MS+60*1000), stamp: qlStamp(HIST)}));
check("a prebuilt draft just past the window is gone", qlLoad(ATH, HIST) === null);
reset(); writeAged(26*60*60*1000);
check("yesterday's draft never comes back", qlLoad(ATH, HIST) === null);

// ─── cardActive: a pinned lock-screen card / Live Activity (Will, 08-24) ─────
// The card is a projection of the draft, so while one is up the draft cannot
// expire out from under it — otherwise the in-app QUICK LOG button regenerates,
// the mirror effect rewrites the pinned card, and the athlete's lock screen
// "resets" mid-workout. The history stamp still wins: a real log invalidates
// the draft (and clears the card, upstream).
reset(); store.set(qlKey(ATH), JSON.stringify({...DRAFT, prebuilt:true, savedAt: Date.now()-(QL_RESUME_MS+60*1000), stamp: qlStamp(HIST)}));
check("card active: an expired prebuilt draft still resumes", qlLoad(ATH, HIST, {cardActive:true}) !== null);
reset(); writeAged(26*60*60*1000);
check("card active: even yesterday's draft resumes (the card's own expiry bounds this)", qlLoad(ATH, HIST, {cardActive:true}) !== null);
reset(); qlSave(ATH, HIST, DRAFT);
check("card active: a real session logged since STILL drops the draft (double-log guard outranks the card)",
  qlLoad(ATH, [{id:"w10", parsed_data:{exercises:[{name:"Bench Press", sets:3, reps:5, weight:185}]}}, ...HIST], {cardActive:true}) === null);
reset();
check("card active: no saved draft is still no draft", qlLoad(ATH, HIST, {cardActive:true}) === null);

// Staleness — they logged a REAL session through chat while the draft sat parked.
// THE double-log guard. Only rows that are real training count: the workouts
// table holds a row for EVERY chat message, and fingerprinting the raw list let a
// plain conversation with Joe destroy a fully-edited draft (Will, 2026-08-05).
const REAL = {id:"w10", parsed_data:{exercises:[{name:"Bench Press", sets:3, reps:5, weight:185}]}};
reset(); qlSave(ATH, HIST, DRAFT);
check("a new session logged since → draft dropped", qlLoad(ATH, [REAL,...HIST]) === null);
reset(); qlSave(ATH, [], DRAFT);
check("first-ever log lands while parked → draft dropped", qlLoad(ATH, [REAL]) === null);
reset(); qlSave(ATH, HIST, DRAFT);
check("chat Q&A rows while parked do NOT drop the draft", qlLoad(ATH, [{id:"chat1", parsed_data:{exercises:[], pr_attempts:[]}}, ...HIST]) !== null);
reset(); qlSave(ATH, HIST, DRAFT);
check("a position claim in chat does NOT drop the draft", qlLoad(ATH, [{id:"chat2", parsed_data:{exercises:[], program_position_claim:{week:2,day:3}}}, ...HIST]) !== null);

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
check("a real session without an id still fingerprints", qlStamp([{created_at:"2026-07-21", parsed_data:{exercises:[{name:"Squat"}]}}]) !== qlStamp([]));
check("chat-only history stamps the same as empty", qlStamp([{id:"c1", parsed_data:{exercises:[]}}]) === qlStamp([]));
check("a run counts as a real session for the stamp", qlStamp([{id:"r1", parsed_data:{run_data:{run_type:"easy"}}}]) !== qlStamp([]));

// ─── position stamp + conflict (the "I'm on day 3" fix) ──────────────────────
// A draft carries the {week, day} it was built for; the boot path regenerates on
// a definite conflict with the current resolved position. Unknown on either side
// is NEVER a conflict — that's what stops a regenerate-every-boot loop.
reset(); qlSave(ATH, HIST, {...DRAFT, position:{week:2, day:2}});
const posGot = qlLoad(ATH, HIST);
check("position round-trips through park/resume", posGot && posGot.position && posGot.position.week===2 && posGot.position.day===2);
reset(); qlSave(ATH, HIST, DRAFT);
check("a draft saved without a position loads with position null", qlLoad(ATH, HIST).position === null);
check("day mismatch is a conflict", qlPositionConflict({week:2, day:2}, {week:2, day:3}) === true);
check("week mismatch is a conflict", qlPositionConflict({week:1, day:3}, {week:2, day:3}) === true);
check("same position is not a conflict", qlPositionConflict({week:2, day:3}, {week:2, day:3}) === false);
check("unknown saved position is never a conflict", qlPositionConflict(null, {week:2, day:3}) === false);
check("unknown current position is never a conflict", qlPositionConflict({week:2, day:3}, null) === false);
check("unknown week on one side doesn't conflict on week", qlPositionConflict({week:null, day:3}, {week:2, day:3}) === false);
check("day agrees, week unknown one side → resume", qlPositionConflict({week:2, day:3}, {week:null, day:3}) === false);


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

// Content beats order. The model is TOLD the focus note goes above the separator
// and the log below; when it reverses them anyway, the whole workout lands in the
// read-only box and the athlete can't edit their own numbers (Will, 2026-08-05).
// The splitter classifies by content and swaps an unambiguously backwards reply.
{
  const NOTE = "Week 2, Day 3: Oly + Legs. Heavy singles, keep bar speed honest.\nTies into your knee rehab focus.";
  const LOG = "Day 3 – OLY + Legs\n\nSnatch 3x1 @ 225 (90%)\nClean & Jerk 3x1 @ 250 (88%)\nFront Squat 3x2 @ 265 (90%)";
  const ok1 = splitQuickLogReply(`${NOTE}\n===\n${LOG}`);
  check("correct order passes through untouched", ok1.notes===NOTE && ok1.log===LOG);
  const ok2 = splitQuickLogReply(`${LOG}\n===\n${NOTE}`);
  check("reversed sections swap: log side gets the workout", ok2.log===LOG && ok2.notes===NOTE);
  // A legit focus note may NAME key lifts with loads — that alone must never swap
  // a real log out of the log box.
  const LIFTY_NOTE = "Snatch 3x1 @ 225 (90%)\nClean & Jerk 3x1 @ 250 (88%)\nKeep bar speed honest today.";
  const ok3 = splitQuickLogReply(`${LIFTY_NOTE}\n===\n${LOG}`);
  check("a lift-naming focus note doesn't trigger a swap", ok3.log===LOG && ok3.notes===LIFTY_NOTE);
  const ok4 = splitQuickLogReply("just prose\n===\nmore prose, no numbers");
  check("prose both sides never swaps", ok4.notes==="just prose" && ok4.log==="more prose, no numbers");
  const sw = streamQuickLogReply(`${LOG}\n===\npartial pro`);
  check("streaming never swaps mid-flight", sw.log==="partial pro");
}

// ─── app-open opener cache (day-stamped) ─────────────────────────────────────
// At stake: showing YESTERDAY's session as today's opener. The day stamp is the
// whole guard, so the cross-midnight cases matter most.
const MORNING = new Date("2026-07-22T09:00:00").getTime();       // local time, no Z
const LATER   = new Date("2026-07-22T20:00:00").getTime();       // same local day
const NEXTDAY = new Date("2026-07-23T06:00:00").getTime();       // next local day
reset();
openerSave(ATH, "What's up. Here's today — Upper A:\n\nBench 5x5 @ 185", MORNING);
check("opener round-trips same day", openerLoad(ATH, LATER) === "What's up. Here's today — Upper A:\n\nBench 5x5 @ 185");
check("opener from a prior day is dropped", openerLoad(ATH, NEXTDAY) === null);
check("no opener saved → null", openerLoad("nobody", MORNING) === null);
reset();
openerSave(ATH, "   ", MORNING);          // blank/whitespace never persists
check("a blank opener is not saved", openerLoad(ATH, MORNING) === null);
openerSave(ATH, "", MORNING);
check("an empty opener is not saved", openerLoad(ATH, MORNING) === null);
openerSave("", "hi", MORNING);            // missing athlete id is a no-op
check("missing athlete id doesn't crash or save", openerLoad("", MORNING) === null);
reset();
openerSave(ATH, "morning session", MORNING);
openerSave(ATH, "re-generated same day", LATER);   // a later save overwrites the day's opener
check("a later same-day save overwrites", openerLoad(ATH, LATER) === "re-generated same day");

// T57 s5: a mid-day program change invalidates the cached opener — the coach
// can swap the program from the dashboard and the athlete's next open must not
// greet them with the replaced program's day.
reset();
openerSave(ATH, "Here's today — Day 4", MORNING, "PROGRAM A\nBench 3x5");
check("same program same day → cache hit", openerLoad(ATH, LATER, "PROGRAM A\nBench 3x5") === "Here's today — Day 4");
check("a changed program drops the cached opener", openerLoad(ATH, LATER, "PROGRAM B\nSquat 5x5") === null);
check("a caller that doesn't know the program skips the check", openerLoad(ATH, LATER) === "Here's today — Day 4");
reset();
openerSave(ATH, "legacy entry", MORNING);          // pre-stamp cache entry
check("a legacy un-stamped entry stays valid for the day", openerLoad(ATH, LATER, "PROGRAM A") === "legacy entry");

// ─── a program written in the conversation ───────────────────────────────────
// The false-positive direction is the dangerous one: treating Joe's prose (or a
// workout the athlete already finished) as "the program" makes Quick Log prescribe
// the wrong session. So the NEGATIVE cases carry the weight here.
const CHAT_PROGRAM = `Here's today:

Bench Press 4x6 @ 185
Incline DB Press 3x10 @ 60
Cable Fly 3x12 @ 40
Tricep Pushdown 3x12 @ 70`;

check("a written session is a program", looksLikeProgramText(CHAT_PROGRAM));
check("3 exercise lines is the floor", looksLikeProgramText("Squat 5x5 @ 225\nRDL 3x8 @ 185\nLeg Press 3x12 @ 270"));
check("2 exercise lines is not a program", !looksLikeProgramText("Squat 5x5 @ 225\nRDL 3x8 @ 185"));
check("prose mentioning lifts is not a program", !looksLikeProgramText("Get your bench 3x5 in before the 5x10 accessory work and you'll be fine."));
check("empty text is not a program", !looksLikeProgramText(""));
check("null doesn't crash", !looksLikeProgramText(null));
check("bare numbers with no lift name don't count", !looksLikeProgramText("4x6\n3x10\n3x12"));
check("dash/numbered lists still count", looksLikeProgramText("- Back Squat 5x5\n- Bench Press 5x5\n- Barbell Row 5x5"));
check("'sets of' phrasing counts", looksLikeProgramText("Back Squat 5 sets of 5\nBench Press 3 sets of 8\nBarbell Row 3 sets of 8"));

// Joe's messages only — an athlete's own pasted log is NOT the program (a Quick Log
// draft is formatted exactly like one, and re-prescribing it would double the day).
check("finds Joe's program", findChatProgram([
  {role:"user", content:"what should I do today"},
  {role:"assistant", content:CHAT_PROGRAM},
]) === CHAT_PROGRAM.trim());
check("ignores an athlete-written session", findChatProgram([{role:"user", content:CHAT_PROGRAM}]) === null);
check("no program in chat → null", findChatProgram([
  {role:"assistant", content:"Nice work today."},
  {role:"user", content:"thanks"},
]) === null);
check("empty/garbage message lists → null", findChatProgram([]) === null && findChatProgram(null) === null);
// Newest wins, so a revision supersedes the version it replaced.
const REVISED = "Flat Bench 4x6 @ 185\nIncline DB Press 3x10 @ 60\nCable Fly 3x12 @ 40";
check("newest program wins", findChatProgram([
  {role:"assistant", content:CHAT_PROGRAM},
  {role:"user", content:"swap the incline for flat"},
  {role:"assistant", content:REVISED},
]) === REVISED);

// ─── a rejected program must not survive into the draft ──────────────────────
// Will's exact case: asked for an adjusted day, didn't like it, asked again, liked the
// second — and Quick Log built the log out of BOTH. The rejected version's CONTENT has
// to be gone, not merely labelled, because any line left behind is a line that can be
// merged in.
const REJECTED = "Bench Press 4x6 @ 185\nDips 3x10\nSkull Crusher 3x12 @ 65";
const ACCEPTED = "Flat Bench 5x5 @ 195\nIncline DB Press 3x10 @ 60\nCable Fly 3x12 @ 40";
const CONVO = [
  {role:"user", content:"adjust today for me"},
  {role:"assistant", content:REJECTED},
  {role:"user", content:"nah do it again"},
  {role:"assistant", content:ACCEPTED},
];
const marked = markSupersededPrograms(CONVO);
check("the accepted version survives intact", marked[3].content === ACCEPTED);
check("the rejected version's content is gone", marked[1].content === QL_SUPERSEDED);
check("no exercise from the rejected version leaks", !marked.some(m=>/Skull Crusher|Dips/.test(m.content)));
check("the rejected turn is kept so the revision still reads", marked.length === CONVO.length && marked[1].role === "assistant");
check("the athlete's own turns are untouched", marked[0].content === "adjust today for me" && marked[2].content === "nah do it again");
check("findChatProgram agrees on the winner", findChatProgram(CONVO) === ACCEPTED);

// Three versions: only the last one lives.
const three = markSupersededPrograms([
  {role:"assistant", content:REJECTED},
  {role:"assistant", content:"Squat 5x5 @ 225\nRDL 3x8 @ 185\nLeg Press 3x12 @ 270"},
  {role:"assistant", content:ACCEPTED},
]);
check("only the last of three versions survives", three[0].content===QL_SUPERSEDED && three[1].content===QL_SUPERSEDED && three[2].content===ACCEPTED);

// A single program, or none, must pass through completely unchanged — this runs on
// EVERY draft, including the overwhelming majority with nothing to supersede.
const single = [{role:"user",content:"what's today"},{role:"assistant",content:ACCEPTED}];
check("a lone program is left alone", markSupersededPrograms(single)[1].content === ACCEPTED);
const noProg = [{role:"assistant",content:"Nice work today."},{role:"user",content:"thanks"}];
check("a conversation with no program is unchanged", markSupersededPrograms(noProg)[0].content === "Nice work today.");
check("empty/garbage input doesn't crash", markSupersededPrograms([]).length===0 && markSupersededPrograms(null).length===0);
// Joe's ordinary prose is never mistaken for a superseded program.
const prose = [
  {role:"assistant", content:"Get your bench 3x5 in first."},
  {role:"assistant", content:ACCEPTED},
];
check("prose isn't wiped as a superseded program", markSupersededPrograms(prose)[0].content === "Get your bench 3x5 in first.");

// ─── the save-to-program offer is rate limited ───────────────────────────────
reset();
const D1 = new Date("2026-07-27T09:00:00").getTime();
const D1_LATER = new Date("2026-07-27T20:00:00").getTime();
const D2 = new Date("2026-07-28T09:00:00").getTime();
const D3 = new Date("2026-07-29T09:00:00").getTime();
const D4 = new Date("2026-07-30T09:00:00").getTime();
check("first offer is allowed", programSaveOfferAllowed(ATH, D1));
markProgramSaveOffered(ATH, D1);
check("no second offer the same day", !programSaveOfferAllowed(ATH, D1_LATER));
check("allowed again the next day", programSaveOfferAllowed(ATH, D2));
markProgramSaveOffered(ATH, D2);
markProgramSaveOffered(ATH, D3);
check(`spent after ${QL_PROGRAM_OFFER_MAX} lifetime offers`, !programSaveOfferAllowed(ATH, D4));
check("offers are scoped per athlete", programSaveOfferAllowed("ath-other", D4));
check("missing athlete id is never offered", !programSaveOfferAllowed("", D1));

// ─── REQUESTED DAY (T19 #4) ──────────────────────────────────────────────────
// Quick Log drafted TODAY no matter what the athlete said, so "log yesterday's
// workout" prefilled the wrong session and the whole feature got typed by hand.
// NOW is a Thursday (2026-07-30) so weekday math has a fixed reference.
{
  const NOW = new Date(2026, 6, 30, 9, 0, 0);   // Thu Jul 30 2026, local
  const p = (t) => parseRequestedDate(t, NOW);

  // No date stated = today = no backdating (null, so the caller keeps today's path)
  check("plain log has no requested date", p("bench 3x5 at 225") === null);
  check("empty text has no requested date", p("") === null);
  check("'today' is explicitly not a backdate", p("log today's workout") === null);
  check("'just finished' is not a backdate", p("just finished squats") === null);

  // Relative
  check("yesterday resolves", p("log yesterday's workout") === "2026-07-29");
  check("last night resolves to yesterday", p("logging last night's lift") === "2026-07-29");
  check("2 days ago resolves", p("did this 2 days ago") === "2026-07-28");
  check("day before yesterday resolves", p("day before yesterday I squatted") === "2026-07-28");
  check("14 days ago is the edge and allowed", p("14 days ago") === "2026-07-16");
  check("15 days ago is out of range", p("15 days ago") === null);

  // Weekday names — most recent ALREADY-PASSED occurrence
  check("Tuesday resolves back", p("log Tuesday's session") === "2026-07-28");
  check("Monday resolves back", p("Monday's workout") === "2026-07-27");
  check("'last Friday' resolves back", p("last Friday I benched") === "2026-07-24");
  check("same weekday as today means LAST week", p("log Thursday's workout") === "2026-07-23");

  // Explicit dates
  check("ISO date resolves", p("logging 2026-07-24") === "2026-07-24");
  check("M/D resolves", p("did this 7/24") === "2026-07-24");
  check("'on the 24th' resolves", p("on the 24th I squatted") === "2026-07-24");
  check("a FUTURE iso date is refused", p("2026-08-05") === null);
  check("a FUTURE m/d is refused", p("8/5") === null);
  check("an impossible date is refused", p("2/30") === null);

  // A backdated draft must never be confused with today's
  check("yesterday and today differ", p("yesterday") !== null && p("today") === null);
  check("backdate window constant is exported", QL_MAX_BACKDATE_DAYS === 14);
}

// ─── THE WORKOUT IN PROGRESS (Will, TestFlight, 09-29) ───────────────────────
// "If you start a workout and haven't finished it or cancelled it, your edits
// should remain even after closing out of the app."
{
  const real = (id) => ({id, parsed_data:{exercises:[{name:"Bench Press", sets:3, reps:5, weight:185}]}});
  const chat = (id) => ({id, parsed_data:{exercises:[]}});
  const GEN = {draft:"Day 2\n\nFront Squat 4x2 @ 120kg", notes:"Focus: fast elbows", undoStack:[], prebuilt:true, position:{week:3, day:2}};
  const EDITED = "Day 2\n\nFront Squat 4x2 @ 100kg/110kg/120kg/120kg";

  // ── the sliding window (his account: 233 rows against a 100-row window) ──
  // Parked against 100 rows holding real sessions at both ends. Three chat
  // messages later the next boot's window has dropped the three oldest rows,
  // one of them real. Nothing was logged. The sheet must still be there.
  const mid = Array.from({length:96}, (_,i)=>chat("c"+i));
  const before = [real("newest"), ...mid, real("old-a"), chat("old-b"), real("old-c")];
  const after  = [chat("n1"), chat("n2"), chat("n3"), real("newest"), ...mid];
  check("window fixture really does change the real-session count", qlStamp(before) !== qlStamp(after));
  reset(); qlSave(ATH, before, GEN); qlEdit(ATH, before, {draft:EDITED, dock:true});
  check("chat rows sliding old sessions out of the window do NOT drop the sheet", qlLoad(ATH, after)?.draft === EDITED);
  reset(); qlSave(ATH, before, GEN);
  check("...nor an untouched draft", qlLoad(ATH, after) !== null);
  check("a session logged since still drops it (the guard is the newest session)", qlLoad(ATH, [real("brand-new"), ...after]) === null);
  check("stamp head: reads the id past the count", qlStampHead("34:abc-123") === "abc-123");
  check("stamp head: an id holding a colon survives", qlStampHead("2:2026-07-21T14:00:00Z") === "2026-07-21T14:00:00Z");
  check("stamp head: empty history", qlStampHead(qlStamp([])) === "");
  check("stamp match: a park with no stamp never matches", qlStampMatches(undefined, []) === false);
  // A park written by the bundle before this one carries the same stamp shape.
  reset(); store.set(qlKey(ATH), JSON.stringify({draft:EDITED, savedAt:Date.now(), stamp:"3:newest"}));
  check("a park from the previous bundle still loads", qlLoad(ATH, after)?.draft === EDITED);

  // ── an edit is the athlete's, and says so ──
  reset(); qlSave(ATH, HIST, GEN); qlEdit(ATH, HIST, {draft:EDITED});
  let r = qlLoad(ATH, HIST);
  check("edit: the text is what they typed", r.draft === EDITED);
  check("edit: the park is the athlete's now (prebuilt dropped)", r.prebuilt === false);
  check("edit: the position the draft was built for survives", r.position && r.position.week === 3 && r.position.day === 2);
  check("edit: the focus note survives when the edit carries none", r.notes === "Focus: fast elbows");
  qlEdit(ATH, HIST, {draft:EDITED, notes:"Focus: hips"});
  check("edit: a new note replaces the old", qlLoad(ATH, HIST).notes === "Focus: hips");
  check("a generated draft is still the app's (prebuilt)", (reset(), qlSave(ATH, HIST, GEN), qlLoad(ATH, HIST).prebuilt === true));
  reset(); qlSave(ATH, HIST, GEN); qlEdit(ATH, HIST, {draft:"   "});
  check("edit: an emptied sheet clears the park", qlPeek(ATH) === null);
  reset(); qlEdit(ATH, HIST, {draft:EDITED, dock:true});
  check("edit with no park underneath still saves (they typed a whole sheet)", qlLoad(ATH, HIST)?.draft === EDITED);

  // ── the bar ──
  reset(); qlSave(ATH, HIST, GEN);
  check("a generated draft has no bar", qlLoad(ATH, HIST).dock === false);
  check("no bar, no card: nothing comes back on boot", qlResumeDock(qlLoad(ATH, HIST)) === false);
  check("start raises the bar", qlSetDock(ATH, true) === true && qlLoad(ATH, HIST).dock === true);
  check("the bar comes back on boot with no lock-screen card", qlResumeDock(qlLoad(ATH, HIST), {cardActive:false}) === true);
  qlEdit(ATH, HIST, {draft:EDITED});
  r = qlLoad(ATH, HIST);
  check("an edit keeps the bar up", r.dock === true && r.draft === EDITED);
  check("the X takes the bar down", qlSetDock(ATH, false) === true && qlLoad(ATH, HIST).dock === false);
  check("cancelled: no bar on boot", qlResumeDock(qlLoad(ATH, HIST)) === false);
  check("cancelled: the text is still parked", qlLoad(ATH, HIST).draft === EDITED && qlLoad(ATH, HIST).prebuilt === false);
  check("a live card still raises the bar (the rule before this one)", qlResumeDock(qlLoad(ATH, HIST), {cardActive:true}) === true);
  reset();
  check("no park: raising the bar writes nothing", qlSetDock(ATH, true) === false && qlPeek(ATH) === null);
  check("no park: nothing to resume", qlResumeDock(qlLoad(ATH, HIST), {cardActive:true}) === false);
  reset(); qlSave(ATH, HIST, GEN); qlSetDock(ATH, true); qlClear(ATH);
  check("finished (cleared): nothing comes back", qlResumeDock(qlLoad(ATH, HIST)) === false);

  // ── the clock ──
  // A draft built at 5am and STARTED at 2pm begins at 2pm.
  reset(); store.set(qlKey(ATH), JSON.stringify({...GEN, savedAt: Date.now()-(QL_RESUME_MS+60*1000), stamp: qlStamp(HIST)}));
  check("an expired untouched draft is gone", qlLoad(ATH, HIST) === null);
  qlSetDock(ATH, true);
  check("starting it restarts its clock", qlLoad(ATH, HIST)?.dock === true);
  // ...but raising a bar that is already up must not, or it never expires.
  const t0 = Date.now()-3*60*60*1000;
  reset(); store.set(qlKey(ATH), JSON.stringify({...GEN, dock:true, savedAt:t0, stamp: qlStamp(HIST)}));
  qlSetDock(ATH, true);
  check("re-raising a bar that is up does not move the clock", qlPeek(ATH).savedAt === t0);
  // A started sheet gets the athlete's same-day grace even if never typed on.
  reset(); store.set(qlKey(ATH), JSON.stringify({...GEN, dock:true, savedAt: new Date().setHours(0,5,0,0), stamp: qlStamp(HIST)}));
  check("a started sheet from early this morning is there all day", qlLoad(ATH, HIST) !== null);
  reset(); store.set(qlKey(ATH), JSON.stringify({...GEN, dock:true, prebuilt:false, savedAt: Date.now()-26*60*60*1000, stamp: qlStamp(HIST)}));
  check("yesterday's unfinished sheet does not haunt today", qlLoad(ATH, HIST) === null);

  // ── the date on the sheet ──
  reset(); qlSave(ATH, HIST, GEN); qlSetDock(ATH, true);
  qlSetSheetDate(ATH, "2026-09-28");
  check("the sheet's date is kept", qlLoad(ATH, HIST).sheetDate === "2026-09-28");
  check("...apart from the old screen's targetDate (the pin path regenerates on that)", qlLoad(ATH, HIST).targetDate === null);
  qlEdit(ATH, HIST, {draft:EDITED});
  check("an edit keeps the date", qlLoad(ATH, HIST).sheetDate === "2026-09-28");
  qlSetSheetDate(ATH, "");
  check("back to today clears it", qlLoad(ATH, HIST).sheetDate === "");

  // ── a lift logged in chat while the edited sheet is up ──
  reset(); qlSave(ATH, HIST, GEN); qlSetDock(ATH, true); qlEdit(ATH, HIST, {draft:EDITED});
  const logged = [real("mid-workout"), ...HIST];
  check("before the re-stamp the chat log would drop the sheet", qlLoad(ATH, logged) === null);
  check("re-stamp follows the history", qlRestamp(ATH, logged) === true && qlLoad(ATH, logged)?.draft === EDITED);
  reset(); qlSave(ATH, HIST, GEN); qlSetDock(ATH, true);
  check("an untouched sheet is NOT re-stamped (the session was logged another way)", qlRestamp(ATH, logged) === false && qlLoad(ATH, logged) === null);
  reset(); qlSave(ATH, HIST, GEN); qlEdit(ATH, HIST, {draft:EDITED});
  check("an edited park with the bar down is NOT re-stamped (double-log guard)", qlRestamp(ATH, logged) === false && qlLoad(ATH, logged) === null);
}


console.log(`\n${fail===0?"✓":"✗"} quick log draft: ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
