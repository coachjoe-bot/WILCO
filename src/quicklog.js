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

export const qlKey = (athleteId) => `wilco_quicklog_${athleteId}`;

// How long a parked draft stays resumable. Deliberately a rolling window rather than "same
// calendar day": a session that starts at 11:40pm has to still resume at 12:10am. Long
// enough for any real workout, short enough that yesterday's draft never comes back.
export const QL_RESUME_MS = 8*60*60*1000;

// Fingerprint of the athlete's logged history, stamped onto a saved draft. If it differs on
// reopen, they logged through chat while the draft sat parked — the draft is stale and
// resuming it would double-log the session, so it gets thrown out instead. Row 0 is the
// newest (every load is order=created_at.desc and new logs are prepended). In-place
// corrections re-map the array without changing its length or its head, so they leave a
// draft resumable — only genuinely new sessions invalidate it.
export const qlStamp = (workoutHistory) => {
  const h = Array.isArray(workoutHistory)?workoutHistory:[];
  return `${h.length}:${(h[0]&&(h[0].id??h[0].created_at))||""}`;
};

// The resumable draft, or null. Every rejection path (missing, corrupt, expired, stale,
// empty) returns null so the caller just redrafts — a lost draft is never worth an error
// state in front of someone mid-workout.
export const qlLoad = (athleteId, workoutHistory) => {
  try{
    const d = JSON.parse(localStorage.getItem(qlKey(athleteId))||"null");
    if(!d || typeof d.draft!=="string" || !d.draft.trim()) return null;
    if(Date.now()-(d.savedAt||0) >= QL_RESUME_MS) return null;
    if(d.stamp !== qlStamp(workoutHistory)) return null;
    return {
      draft: d.draft,
      notes: typeof d.notes==="string" ? d.notes : "",
      undoStack: Array.isArray(d.undoStack) ? d.undoStack : [],
    };
  }catch(_){ return null; }
};

// Saving an empty draft clears instead — an emptied textarea means "nothing to come back
// to", and leaving a stale row behind would light up the RESUME LOG nav label for nothing.
export const qlSave = (athleteId, workoutHistory, {draft, notes, undoStack}) => {
  try{
    if(!draft||!draft.trim()){ qlClear(athleteId); return; }
    localStorage.setItem(qlKey(athleteId), JSON.stringify({
      draft,
      notes: notes||"",
      undoStack: (undoStack||[]).slice(-5), // a nicety, not worth growing the payload unbounded
      savedAt: Date.now(),
      stamp: qlStamp(workoutHistory),
    }));
  }catch(_){}
};

export const qlClear = (athleteId) => { try{ localStorage.removeItem(qlKey(athleteId)); }catch(_){} };
