// ─── QUICK LOG DRAFT PERSISTENCE ─────────────────────────────────────────────
// A Quick Log draft is a workout IN PROGRESS — the athlete opens it between sets, closes
// it, trains, comes back. So closing the sheet must never throw the draft (or their edits)
// away. React state can't carry it: the sheet unmounts on close, and iOS evicts the whole
// PWA the moment they switch to music or the camera mid-session, so a reopen is often a
// cold boot. localStorage is the only store that survives both.
//
// This lives in its own module rather than inside App.jsx because the rules below are the
// data-safety half of the feature — resuming a draft the athlete already logged would
// double-log their session — and rules that can corrupt history get a regression suite
// (scripts/test-quicklog-draft.mjs).

import { isRealSession } from "./grit.js";

export const qlKey = (athleteId) => `wilco_quicklog_${athleteId}`;

// How long a parked draft stays resumable. For a PREBUILT draft (the app's own
// speculative generation) this rolling window is the whole rule. A draft the
// athlete actually EDITED additionally survives for the rest of its local
// calendar day (see qlLoad): Will edited a whole workout at the gym, came back
// an hour later, and it was gone — an athlete's own typing must persist until
// it's sent, discarded, or genuinely a different day. The rolling window still
// covers the 11:40pm-session-resumed-at-12:10am case across midnight.
export const QL_RESUME_MS = 8*60*60*1000;

// Fingerprint of the athlete's LOGGED SESSIONS, stamped onto a saved draft. If it
// differs on reopen, they logged a real session through chat while the draft sat
// parked — the draft is stale and resuming it would double-log, so it gets thrown
// out instead. REAL sessions only (isRealSession — the same definition session
// grouping trusts): the workouts table holds a row for EVERY chat message, so
// fingerprinting the raw list meant a plain conversation with Joe ("what day am I
// on?") silently destroyed a fully-edited parked draft. That is exactly what ate
// Will's gym-morning edits (2026-08-05). Q&A rows, position claims, and form
// reviews no longer invalidate; only new logged training does.
export const qlStamp = (workoutHistory) => {
  const h = (Array.isArray(workoutHistory)?workoutHistory:[]).filter(isRealSession);
  return `${h.length}:${(h[0]&&(h[0].id??h[0].created_at))||""}`;
};

// What staleness is actually judged on: the NEWEST real session, never the
// count. The history the app holds is a sliding window (the latest 100 rows,
// and the table carries a row per chat message), so the count of real sessions
// inside it moves on its own: send Joe three messages mid-workout, close the
// app, and the next boot's window has dropped three old rows. When one of those
// was a real session the count fell, the stamp "changed", and a sheet full of
// the athlete's edits was thrown away on reopen (Will, TestFlight, 09-29). A
// session logged since the park always becomes the newest real row, so the
// head alone carries the whole double-log guard.
export const qlStampHead = (stamp) => {
  const s = String(stamp ?? "");
  const i = s.indexOf(":");
  return i < 0 ? s : s.slice(i+1);
};
export const qlStampMatches = (saved, workoutHistory) =>
  typeof saved === "string" && qlStampHead(saved) === qlStampHead(qlStamp(workoutHistory));

// The resumable draft, or null. Every rejection path (missing, corrupt, expired, stale,
// empty) returns null so the caller just redrafts — a lost draft is never worth an error
// state in front of someone mid-workout.
export const qlLoad = (athleteId, workoutHistory, {cardActive=false} = {}) => {
  try{
    const d = JSON.parse(localStorage.getItem(qlKey(athleteId))||"null");
    if(!d || typeof d.draft!=="string" || !d.draft.trim()) return null;
    // Athlete-edited drafts survive the rolling window OR the same local day,
    // whichever is longer; prebuilt drafts get the window only (nobody loses
    // work if a speculative draft regenerates).
    //
    // cardActive: a pinned lock-screen card / Live Activity is a live projection
    // of THIS draft (T40 invariant: the sheet and the lock screen never show two
    // different sessions). While one is up, the draft it projects must not
    // expire out from under it — otherwise opening the sheet in-app regenerates
    // and the mirror effect "resets" the pinned card mid-workout (Will, 08-24).
    // The card's own lifecycle (clear-on-log, same-day age cap, boot expiry)
    // bounds how long this leniency can last, and the history stamp below still
    // applies — though a real log also takes the card down, so they can't fight.
    const withinWindow = Date.now()-(d.savedAt||0) < QL_RESUME_MS;
    const sameLocalDay = !!d.savedAt && qlLocalDay(d.savedAt) === qlLocalDay();
    // The athlete's own: they changed it (any save from the sheet drops the
    // prebuilt flag), or they STARTED it (the bar is up). Either one gets the
    // same-day grace; only an untouched, unstarted speculative draft is held
    // to the rolling window alone.
    const owned = !d.prebuilt || !!d.dock;
    // A STARTED workout (the bar is up) never expires (Will 09-29: "leave it
    // until its dealt with by the athlete"). Finish and the X are the only
    // ways out; the clock below only governs text with no bar on it.
    if(!cardActive && !d.dock && (owned ? !(withinWindow || sameLocalDay) : !withinWindow)) return null;
    if(!qlStampMatches(d.stamp, workoutHistory)) return null;
    return {
      draft: d.draft,
      notes: typeof d.notes==="string" ? d.notes : "",
      undoStack: Array.isArray(d.undoStack) ? d.undoStack : [],
      prebuilt: !!d.prebuilt,
      // When the park was last written (a generate, an edit, a start).
      savedAt: d.savedAt||0,
      // When the bar went up: the day the workout was started.
      dockedAt: d.dock ? (d.dockedAt || d.savedAt || 0) : 0,
      // dock: the workout bar is up, a session is in progress. Survives a cold
      // boot so the bar comes back with the same text; goes false on Finish
      // (the park is cleared) and on the bar's X.
      dock: !!d.dock,
      // The sheet's "logging for" date ("" = today). Kept apart from targetDate,
      // which belongs to the old Quick Log screen and makes the pin path
      // regenerate.
      sheetDate: typeof d.sheetDate==="string" ? d.sheetDate : "",
      // Resolved program position {week, day} this draft was built for — the
      // boot path compares it against the CURRENT resolved position and
      // regenerates on mismatch, so a draft built before "I'm on day 3" landed
      // can never resume as the wrong day.
      position: d.position && typeof d.position==="object" ? {week: d.position.week??null, day: d.position.day??null} : null,
      // Warm-up / cool-down tap-to-log toggles (Program Builder: two booleans
      // only — full prep detail lives in the program text, never the log).
      prep: d.prep && typeof d.prep==="object" ? {warmup:!!d.prep.warmup, cooldown:!!d.prep.cooldown} : {warmup:false, cooldown:false},
      // The day this draft is FOR (T19 #4). null = today. Carried so a backdated
      // draft can never be resumed as today's log, or vice versa: the sheet
      // compares this against the day currently being logged and throws the
      // draft away on a mismatch rather than silently prefilling the wrong day.
      targetDate: typeof d.targetDate==="string" ? d.targetDate : null,
    };
  }catch(_){ return null; }
};

// Saving an empty draft clears instead — an emptied textarea means "nothing to come back
// to", and leaving a stale row behind would light up the RESUME LOG nav label for nothing.
// `prebuilt` marks a draft the app generated in the BACKGROUND, before the athlete
// ever opened the sheet (see qlPrebuildEligible). It must not be presented as
// "picked up where you left off" — nobody left off anywhere — and must not light
// the RESUME LOG nav label, which is a promise about the athlete's own unfinished
// work. Any later save from the sheet omits the flag, so the moment they touch it
// the draft becomes a normal parked one.
export const qlSave = (athleteId, workoutHistory, {draft, notes, undoStack, prebuilt, prep, targetDate, position, dock, sheetDate}) => {
  try{
    if(!draft||!draft.trim()){ qlClear(athleteId); return; }
    // The start time rides along with the bar through every rewrite of the park.
    const was = dock ? qlPeek(athleteId) : null;
    localStorage.setItem(qlKey(athleteId), JSON.stringify({
      draft,
      notes: notes||"",
      undoStack: (undoStack||[]).slice(-5), // a nicety, not worth growing the payload unbounded
      savedAt: Date.now(),
      stamp: qlStamp(workoutHistory),
      prebuilt: !!prebuilt,
      dock: dock ? true : undefined,
      dockedAt: dock ? ((was && was.dock && was.dockedAt) || Date.now()) : undefined,
      sheetDate: typeof sheetDate==="string" && sheetDate ? sheetDate : undefined,
      prep: prep && (prep.warmup||prep.cooldown) ? {warmup:!!prep.warmup, cooldown:!!prep.cooldown} : undefined,
      targetDate: typeof targetDate==="string" && targetDate ? targetDate : undefined,
      position: position && (position.week!=null || position.day!=null) ? {week: position.week??null, day: position.day??null} : undefined,
    }));
  }catch(_){}
};

// Does a parked draft's position disagree with the CURRENT resolved position?
// Only a definite conflict counts: both sides must know the day (and the week,
// when both weeks are known) — an unknown on either side is never grounds to
// throw away work. This is what makes "I'm on day 3" reach a draft that was
// built while the app still thought day 2.
export const qlPositionConflict = (saved, current) => {
  if(!saved || !current) return false;
  if(saved.day!=null && current.day!=null && saved.day!==current.day) return true;
  if(saved.week!=null && current.week!=null && saved.week!==current.week) return true;
  return false;
};

// ─── THE WORKOUT IN PROGRESS (Will, 09-29) ───────────────────────────────────
// His rule: start a workout, change the sheet, close the app, and the changes
// are still there when it opens. They go away only when the workout is finished
// or cancelled. Four things used to break that, and each has its rule here:
//   1. every edit on the chat sheet was saved as `prebuilt` (the app's own
//      speculative draft). The flag's contract is above qlSave: a save from
//      the sheet drops it, and that is how the app knows the text is the
//      athlete's. With it stuck on, typed work looked like a throwaway draft;
//   2. the bar only came back on boot when a lock-screen card was live, so an
//      athlete with no card (web, notifications off, a failed pin) reopened to
//      no bar at all;
//   3. every generator wrote straight over the park: Joe's prefill tool, the
//      card refresh, the in-chat swap (the rule is src/sheetPlan.js);
//   4. the history stamp counted sessions inside a sliding window (qlStampHead).
//
// The raw park, no validity rules. For merges and for deciding what a write is
// about to replace; never for deciding what to SHOW (that is qlLoad).
export const qlPeek = (athleteId) => {
  try{
    const d = JSON.parse(localStorage.getItem(qlKey(athleteId))||"null");
    return d && typeof d.draft==="string" ? d : null;
  }catch(_){ return null; }
};

// The athlete changed the sheet. Everything the park already knew stays (the
// position it was built for, the bar, the date): only the text and the note
// move, and the prebuilt flag drops, which is what marks the park as theirs.
// An emptied sheet clears the park, same as qlSave.
export const qlEdit = (athleteId, workoutHistory, {draft, notes, dock, sheetDate} = {}) => {
  const cur = qlPeek(athleteId) || {};
  qlSave(athleteId, workoutHistory, {
    draft,
    notes: notes ?? cur.notes ?? "",
    undoStack: [],
    prebuilt: false,
    dock: dock ?? !!cur.dock,
    sheetDate: sheetDate ?? cur.sheetDate ?? "",
    position: cur.position,
    prep: cur.prep,
    targetDate: cur.targetDate,
  });
};

// Flip one field on the park without touching the text or its clock. No park,
// no write: a flag has nothing to describe.
const qlPatch = (athleteId, patch) => {
  try{
    const cur = qlPeek(athleteId);
    if(!cur) return false;
    localStorage.setItem(qlKey(athleteId), JSON.stringify({...cur, ...patch}));
    return true;
  }catch(_){ return false; }
};

// The bar went up (a workout started) or came down (the X). A START restarts
// the park's clock: the session begins now, whenever the draft was generated.
// Raising a bar that is already up (the boot resume, a second tool call) moves
// nothing, or a sheet reopened once a day would never expire.
export const qlSetDock = (athleteId, on) => {
  const cur = qlPeek(athleteId);
  if(!cur) return false;
  if(on) return cur.dock ? true : qlPatch(athleteId, {dock:true, savedAt:Date.now(), dockedAt:Date.now()});
  return qlPatch(athleteId, {dock:undefined, dockedAt:undefined});
};

export const qlSetSheetDate = (athleteId, sheetDate) =>
  qlPatch(athleteId, {sheetDate: typeof sheetDate==="string" && sheetDate ? sheetDate : undefined});

// A lift logged through chat while an edited sheet is up moves the newest real
// session, which would read as "logged since the park" on the next boot and
// drop the sheet. The sheet is still on screen and still theirs, so its stamp
// follows the history. Only an in-progress park the athlete changed is
// re-stamped: an untouched draft is left to go stale, the way it always has.
export const qlRestamp = (athleteId, workoutHistory) => {
  const cur = qlPeek(athleteId);
  if(!cur || !cur.dock || cur.prebuilt) return false;
  return qlPatch(athleteId, {stamp: qlStamp(workoutHistory)});
};

// The date the sheet shows when the bar comes back. A date the athlete picked
// always stands. With none picked, a workout resumed on a LATER day than it was
// started shows the day it was started (the usual case is a session that was
// trained and never finished in the app), as long as that day is still inside
// the backdate window. The date sits on the sheet's footer, one tap to change.
// "" means today.
export const qlSheetDateOnResume = (rec, now) => {
  if(!rec) return "";
  if(typeof rec.sheetDate==="string" && rec.sheetDate) return rec.sheetDate;
  if(!rec.dock || !rec.dockedAt) return "";
  const today = qlMidnight(now), started = qlMidnight(rec.dockedAt);
  const days = Math.round((today - started) / 86400000);
  return days >= 1 && days <= QL_MAX_BACKDATE_DAYS ? qlYmd(started) : "";
};

// Should the bar come back on this boot? Pure: the caller hands over what
// qlLoad returned (so every expiry and staleness rule has already run) and
// whether a lock-screen card is live.
export const qlResumeDock = (rec, {cardActive=false} = {}) =>
  !!rec && !!rec.draft && (!!rec.dock || !!cardActive);

// ─── BACKGROUND PRE-BUILD ELIGIBILITY (a cost gate, not a feature flag) ──────
// Pre-building today's draft makes QUICK LOG open instantly instead of behind a
// generation — but a pre-build the athlete never opens is a wasted Sonnet call
// (~$0.01). Two gates keep that bounded and honest:
//   • ONLY athletes who have actually sent a Quick Log in the last 14 days. A
//     brand-new or lapsed athlete never triggers a speculative call, so the spend
//     tracks people who demonstrably use the feature.
//   • AT MOST ONE per athlete per calendar day, so reopening the app ten times
//     costs one generation, not ten.
// Worst case is therefore one call per day per active Quick Log user.
export const QL_PREBUILD_WINDOW_MS = 14*24*60*60*1000;
const qlUsedKey = (athleteId) => `wilco_quicklog_used_${athleteId}`;
const qlPrebuiltKey = (athleteId) => `wilco_quicklog_prebuilt_${athleteId}`;

export const qlMarkUsed = (athleteId) => {
  try{ localStorage.setItem(qlUsedKey(athleteId), String(Date.now())); }catch(_){}
};

// LOCAL date, never UTC — a UTC day stamp rolls over mid-evening and would re-fire
// the pre-build for a second time on the same training day.
export const qlLocalDay = (now) => new Date(now||Date.now()).toLocaleDateString();

// ─── REQUESTED DAY (T19 #4) ──────────────────────────────────────────────────
// Quick Log always drafted TODAY'S session. Told "log yesterday's workout" it
// prefilled the wrong day, and Will ended up typing the whole thing by hand,
// which defeats the entire feature.
//
// These are deliberately the SAME rules the chat parser applies to log_date
// (App.jsx's parse prompt): resolve to the MOST RECENT PAST occurrence, look
// back at most 14 days, never accept a future day, and return null when it is
// ambiguous so the caller can ask instead of guessing. Kept here as a pure
// function so it is testable without a model call and so the sheet, the draft
// generator and the draft key all read ONE answer.
//
// Returns a local "YYYY-MM-DD" string, or null for "no date stated / unclear".
const QL_WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
export const QL_MAX_BACKDATE_DAYS = 14;

const qlYmd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const qlMidnight = (now) => { const d = new Date(now||Date.now()); d.setHours(0,0,0,0); return d; };
const qlShift = (base, days) => { const d = new Date(base); d.setDate(d.getDate()-days); return d; };

export const parseRequestedDate = (text, now) => {
  const t = String(text||"").toLowerCase();
  if (!t.trim()) return null;
  const today = qlMidnight(now);

  // Explicit "today" beats everything and means no backdating.
  if (/\btoday\b|\bthis morning\b|\bthis afternoon\b|\bjust (now|finished|did)\b/.test(t)) return null;

  // "day before yesterday" MUST be tested before the bare "yesterday" rule —
  // /\byesterday\b/ matches inside it and would silently resolve one day late.
  if (/\bday before yesterday\b/.test(t)) return qlYmd(qlShift(today,2));

  // "yesterday"
  if (/\byesterday\b|\blast night\b/.test(t)) return qlYmd(qlShift(today,1));

  // "N days ago" — bounded by the same 14-day window as the chat parser.
  const ago = t.match(/\b(\d{1,2})\s*days?\s+ago\b/);
  if (ago) {
    const n = parseInt(ago[1],10);
    if (n >= 1 && n <= QL_MAX_BACKDATE_DAYS) return qlYmd(qlShift(today,n));
    return null;                                   // out of range → ask, don't guess
  }

  // ISO or M/D (optionally M/D/YY(YY)). Never a future date.
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2])-1, Number(iso[3]));
    d.setHours(0,0,0,0);
    if (isNaN(d.getTime()) || d > today) return null;
    return qlYmd(d);
  }
  const md = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (md) {
    const yRaw = md[3] ? Number(md[3]) : today.getFullYear();
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    const d = new Date(y, Number(md[1])-1, Number(md[2]));
    d.setHours(0,0,0,0);
    if (isNaN(d.getTime()) || d.getMonth() !== Number(md[1])-1) return null;  // e.g. 2/30
    if (d > today) return null;
    return qlYmd(d);
  }
  // "on the 24th" — this month, or last month if that day hasn't happened yet.
  const nth = t.match(/\bon the (\d{1,2})(?:st|nd|rd|th)\b/);
  if (nth) {
    const day = Number(nth[1]);
    if (day < 1 || day > 31) return null;
    let d = new Date(today.getFullYear(), today.getMonth(), day); d.setHours(0,0,0,0);
    if (d > today) { d = new Date(today.getFullYear(), today.getMonth()-1, day); d.setHours(0,0,0,0); }
    if (d.getDate() !== day) return null;          // day doesn't exist in that month
    const back = Math.round((today - d) / 86400000);
    return back <= QL_MAX_BACKDATE_DAYS ? qlYmd(d) : null;
  }

  // Weekday name → most recent ALREADY-PASSED occurrence. If today IS that
  // weekday the athlete means LAST week's, never today's (same rule as the chat
  // parser), because "log Monday's workout" said on a Monday about a session
  // already done reads as this morning, and that case is caught by /today/ above.
  const wd = t.match(/\b(?:last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const want = QL_WEEKDAYS.indexOf(wd[1]);
    let back = (today.getDay() - want + 7) % 7;
    if (back === 0) back = 7;
    return back <= QL_MAX_BACKDATE_DAYS ? qlYmd(qlShift(today, back)) : null;
  }
  return null;
};

// ─── APP-OPEN OPENER CACHE ───────────────────────────────────────────────────
// The generated "here's today's session" opener, cached for the LOCAL calendar day
// so every reopen paints it instantly and free — the ~$0.01 draft call happens at
// most once per day. Day-stamped (not history-stamped like a Quick Log draft)
// because the opener is shown ONLY before today's chat starts: the moment the
// athlete logs or chats, a today-transcript exists and wins over the opener
// outright, so a mid-day history change can never surface a stale opener.
// LOCAL day, never UTC — a UTC stamp rolls over mid-evening and would re-fire the
// draft call a second time on the same training day (same bug class as qlLocalDay).
const qlOpenerKey = (athleteId) => `wilco_today_opener_${athleteId}`;

// Cheap deterministic stamp of the program the opener was drafted from. A
// mid-day program change (a coach assigning from the dashboard, a library
// swap) must invalidate the cached opener, or the athlete opens straight into
// the OLD program's session (T57 s5 live find: the coach put a new block on
// the QA athlete and the next open still greeted with the replaced program's
// day). Callers that don't know the program omit it and skip the check.
const progStamp = (text) => {
  const s = String(text || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
};

export const openerLoad = (athleteId, now, program) => {
  try {
    if (!athleteId) return null;
    const d = JSON.parse(localStorage.getItem(qlOpenerKey(athleteId)) || "null");
    if (!d || d.day !== qlLocalDay(now)) return null;
    if (typeof d.msg !== "string" || !d.msg.trim()) return null;
    if (program !== undefined && d.prog && d.prog !== progStamp(program)) return null;
    return d.msg;
  } catch (_) { return null; }
};

export const openerSave = (athleteId, msg, now, program) => {
  try {
    if (!athleteId || !msg || !String(msg).trim()) return;
    localStorage.setItem(qlOpenerKey(athleteId), JSON.stringify({
      day: qlLocalDay(now), msg: String(msg),
      ...(program !== undefined ? { prog: progStamp(program) } : {}),
    }));
  } catch (_) {}
};

// ── T57 opener choice stamp (Will's 08-19 spec) ──────────────────────────────
// The opener ends on the session body; the in-bubble Start Workout buttons answer it.
// Answered (or typed past) once per LOCAL day: the stamp stops a same-day
// reopen of the cached opener from re-asking a question already answered.
const qlOpenerChoiceKey = (athleteId) => `wilco_opener_choice_${athleteId}`;

export const openerChoiceMadeToday = (athleteId, now) => {
  try { return localStorage.getItem(qlOpenerChoiceKey(athleteId)) === qlLocalDay(now); }
  catch (_) { return true; } // no storage -> never show chips we can't retire
};

export const markOpenerChoice = (athleteId, now) => {
  try { localStorage.setItem(qlOpenerChoiceKey(athleteId), qlLocalDay(now)); } catch (_) {}
};

export const qlPrebuildEligible = (athleteId, now) => {
  try{
    const t = now||Date.now();
    const used = Number(localStorage.getItem(qlUsedKey(athleteId))||0);
    if(!used || t-used >= QL_PREBUILD_WINDOW_MS) return false;
    return localStorage.getItem(qlPrebuiltKey(athleteId)) !== qlLocalDay(t);
  }catch(_){ return false; }
};

// Stamped BEFORE the call goes out, so a failed generation still consumes the
// day's single attempt — retrying a failing prompt on every reopen is the one way
// this could become an unbounded spend.
export const qlMarkPrebuilt = (athleteId, now) => {
  try{ localStorage.setItem(qlPrebuiltKey(athleteId), qlLocalDay(now)); }catch(_){}
};

export const qlClear = (athleteId) => { try{ localStorage.removeItem(qlKey(athleteId)); }catch(_){} };

// ─── A PROGRAM WRITTEN IN THE CONVERSATION ───────────────────────────────────
// Quick Log used to gate purely on the athlete's SAVED program (program_text /
// temp_program_text). No saved program meant the "Add My Program" wall — even when
// Joe had just written them a session in chat two messages earlier. Plenty of
// athletes work exactly that way: they never fill the Program tab, they ask for
// something on the day and train off the answer (Will, 2026-07-27). For them the
// program genuinely exists; it just lives in the transcript.
//
// So this finds it there. Deliberately narrow, because the cost of a false positive
// is real — mistaking a workout the athlete already FINISHED for a plan would have
// Quick Log prescribe the session they just did:
//   • ASSISTANT messages only. Joe writing a session is the signal we want; the
//     athlete's own messages are usually LOGS, and a Quick Log draft is formatted
//     exactly like a program. Athlete-pasted programs already have their own home
//     (the is_program_update flow saves those to the Program tab).
//   • Callers only reach for this when there's NO saved program, so an athlete with
//     a real program in the tab is never affected by anything decided here.
// A single day counts — "write me something for chest today" is the exact case this
// exists for, so requiring a multi-week block would miss the point.

// "Bench Press 4x6", "Incline DB Press 3 x 10 @ 60", "- Squat 5x5", "2. RDL 3x8".
// The lift name has to carry a letter, so a bare "3x8" or a date line can't qualify.
const QL_EX_LINE_RE = /^\s*(?:[-*•]|\d+[.)])?\s*[A-Za-z][A-Za-z0-9 '’&/()+.,-]{2,}?\s+\d+\s*(?:x|×|\s+sets?\s+of\s+)\s*\d+/i;

// A run of exercise lines is what makes something a session rather than a sentence
// mentioning a lift. Three is the floor — two can appear in ordinary coaching prose
// ("get your bench 3x5 in before the 5x10 accessory work").
export const QL_PROGRAM_MIN_EX_LINES = 3;

export const countProgramLines = (text) =>
  String(text || "").split("\n").filter((l) => QL_EX_LINE_RE.test(l)).length;

export const looksLikeProgramText = (text) =>
  countProgramLines(text) >= QL_PROGRAM_MIN_EX_LINES;

// The most recent program Joe wrote in this conversation, or null. Newest-first so a
// revision ("actually swap the incline for flat") wins over the version it replaced.
export const findChatProgram = (messages) => {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== "assistant" || typeof m.content !== "string") continue;
    if (looksLikeProgramText(m.content)) return m.content.trim();
  }
  return null;
};

// ─── SUPERSEDED PROGRAMS IN THE TRANSCRIPT ───────────────────────────────────
// "Adjust today for me" → Joe writes a session → "no, do it again" → Joe writes a
// better one. The athlete has made a clear choice. But the draft prompt is handed the
// last 16 turns VERBATIM and told to honor what the conversation says, so it saw both
// sessions with equal authority and built today's log out of the two of them — the
// rejected version's exercises merged into the one they actually wanted (Will,
// 2026-07-27; it has bitten him more than once).
//
// Picking the newest as THE program isn't enough on its own: the loser is still
// sitting in the conversation block being read. So its content is REPLACED here —
// not just relabelled, because any surviving line of it is a line that can be merged
// in. The turn itself stays so the exchange still reads as a back-and-forth, which is
// what tells the model a revision happened at all.
//
// Applies whether or not the athlete has a saved program: the merge bug came from the
// conversation block, which is built for everyone.
export const QL_SUPERSEDED = "[an earlier version of today's session that the athlete REJECTED, superseded, do not use any part of it]";

export const markSupersededPrograms = (messages) => {
  const list = Array.isArray(messages) ? messages : [];
  // Index of the LAST assistant message that reads as a written session: the only
  // one that survives intact.
  let keep = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === "assistant" && typeof m.content === "string" && looksLikeProgramText(m.content)) { keep = i; break; }
  }
  if (keep < 0) return list;
  return list.map((m, i) => {
    if (i === keep) return m;
    if (m && m.role === "assistant" && typeof m.content === "string" && looksLikeProgramText(m.content)) {
      return { ...m, content: QL_SUPERSEDED };
    }
    return m;
  });
};

// ─── "WANT ME TO KEEP THAT?" — OFFER RATE LIMIT ──────────────────────────────
// A structured program is genuinely the difference between logging workouts and
// making progress, and an athlete with an empty Program tab should hear that. Once.
// Joe writes sessions in chat constantly for these athletes, so an ungated offer
// would attach a pitch to nearly every reply — and a nudge that shows up every day
// stops being a nudge and becomes something you learn to swipe past.
//
// Two limits, both required: at most ONE offer per local calendar day, and at most
// THREE across the athlete's lifetime. After that Joe drops it entirely — they've
// heard the case and declined it three times, which is an answer.
// LOCAL day, never UTC — same rollover trap as qlLocalDay.
export const QL_PROGRAM_OFFER_MAX = 3;
const qlProgOfferKey = (athleteId) => `wilco_prog_offer_${athleteId}`;

const readProgOffer = (athleteId) => {
  try{
    const d = JSON.parse(localStorage.getItem(qlProgOfferKey(athleteId))||"null");
    return d && typeof d==="object" ? {day: d.day||"", count: Number(d.count)||0} : {day:"", count:0};
  }catch(_){ return {day:"", count:0}; }
};

export const programSaveOfferAllowed = (athleteId, now) => {
  if(!athleteId) return false;
  const {day, count} = readProgOffer(athleteId);
  if(count >= QL_PROGRAM_OFFER_MAX) return false;
  return day !== qlLocalDay(now);
};

export const markProgramSaveOffered = (athleteId, now) => {
  try{
    if(!athleteId) return;
    const {count} = readProgOffer(athleteId);
    localStorage.setItem(qlProgOfferKey(athleteId), JSON.stringify({day: qlLocalDay(now), count: count+1}));
  }catch(_){}
};

// ─── THE "===" REPLY SPLITTER ────────────────────────────────────────────────
// Both Quick Log AI calls answer in two sections — the TODAY'S FOCUS note, then a
// "===" line, then the log itself. Three call sites parse that (draft, edit, and
// now the streaming draft, which re-parses on EVERY delta), and getting it wrong
// is not cosmetic: a missed separator dumps Joe's coaching prose straight into the
// athlete's workout log, where it gets parsed as exercises.
//
// `notes` is null — not "" — when there was no separator, so a caller can tell
// "the model rewrote the note as empty" from "the model didn't send a note".
// The edit path depends on that distinction to decide whether to keep the note it
// already has. Deliberately tolerant of any run of 3+ equals signs with padding,
// which is what the models actually emit.
// `^` as well as `\n` so a reply that opens with the separator (the model choosing
// to send no focus note at all) still splits into an EMPTY note rather than being
// read as a log whose first line happens to be "===".
export const QL_SPLIT_RE = /(?:^|\n)[ \t]*={3,}[ \t]*(?:\n|$)/;

// A line that reads as logged training rather than prose: "Name 3x5 @ 185",
// "Snatch 3x1 @ 225 (90%)", "Farmer Carry 4x40yd", "Plank 3x60s".
const QL_LOG_LINE_RE = /(\d+\s*[x×]\s*\d+)|(@\s*_{0,3}\d)|(\d+\s*(?:lbs?|kgs?)\b)/i;
const qlLogLineCount = (s) => String(s || "").split("\n").filter((l) => QL_LOG_LINE_RE.test(l)).length;

// `normalize` guards against the model emitting the two sections in the WRONG
// ORDER (log first, prose second) — which put the whole workout in the read-only
// focus box and the explanation in the editable textarea, so the athlete
// couldn't touch their own numbers (Will, 2026-08-05, on an "I did day 3" edit;
// a recurring failure). Section order is a prompt rule, and prompt rules are not
// guarantees: classify by CONTENT and swap when the split is unambiguously
// backwards — the log side has zero log-shaped lines while the note side has
// several. A legitimate focus note may name key lifts, so the swap needs BOTH
// signals, never just one.
export const splitQuickLogReply = (text, { normalize = true } = {}) => {
  const t = String(text || "").trim();
  const parts = t.split(QL_SPLIT_RE);
  if (parts.length < 2) return { notes: null, log: t };
  let notes = parts[0].trim(), log = parts.slice(1).join("\n").trim();
  if (normalize && log && qlLogLineCount(log) === 0 && qlLogLineCount(notes) >= 2) {
    const swapped = notes; notes = log; log = swapped;
  }
  return { notes, log };
};

// Streaming view of the same reply. Before the separator arrives, everything so
// far IS the focus note (the prompt orders it first), so it renders into the note
// box and the log stays empty. A partial separator mid-stream ("==" at the tail)
// is trimmed off the displayed note rather than flickering as content.
// normalize:false — a half-streamed log section legitimately has zero log lines
// for a moment, and flapping the boxes mid-stream would be worse than the final
// parse (which the non-streaming call sites normalize) landing right.
export const streamQuickLogReply = (accumulated) => {
  const { notes, log } = splitQuickLogReply(accumulated, { normalize: false });
  if (notes !== null) return { notes, log, complete: true };
  return { notes: log.replace(/\n?\s*={1,}\s*$/, "").trim(), log: "", complete: false };
};
