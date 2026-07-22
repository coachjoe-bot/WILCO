// ─── COACH REQUEST RULE SET ──────────────────────────────────────────────────
// Single source of truth for WHEN Joe offers a structured program-change — either
// to the athlete's human coach, or (App.jsx AthleteView self-apply flow) staged
// for the athlete to apply themselves. Both call sites (weekly check-in pain
// question, main chat) route through draftChangeRequest/fileChangeRequest below
// so the rule and the copy never drift apart. Full routing table:
//
// - Program LOCKED by a coach: always a coach request (any flag — pain, plateau,
//   equipment, or an explicit program-change ask). Joe can't touch a locked
//   program, so the coach has to.
// - Program UNLOCKED + athlete has a coach (coach_id set) + PAIN: still a coach
//   request. The coach should hear about pain even though Joe could adapt the
//   program himself right now.
// - Everything else with the program UNLOCKED (plateau or equipment for anyone,
//   or pain for an UNCOACHED athlete): Joe stages the change himself and the
//   athlete applies it — draft → Apply/Edit/Skip → surgical AI merge → diff
//   review → explicit save (App.jsx selfChangePending; same merge/guard code
//   path as the coach-side edit in coach.jsx, via programDiff.js).
// - Explicit program-change ask while the program is locked: always a coach
//   request (covered by the first rule above).
// - One offer per topic per session either way. The athlete always confirms via
//   an explicit tap (Send to coach / Don't send, or Make the change / Edit it
//   first / Leave it) before anything is filed or saved. WILCO never
//   free-messages the coach on the athlete's behalf — every coach request is
//   structured (lift/current/suggested_change/why), never raw chat text.

export const CR_SOURCES = ["pain","plateau","pr","feedback"];

// equipment problems don't have their own DB source value — they fall into the
// general "feedback" bucket in program_change_requests.
export const flagToSource = (flag) => flag==="pain" ? "pain" : flag==="plateau" ? "plateau" : "feedback";

// One Haiku call that authors the request text a coach will actually read.
// askClaude is passed in (not imported) to keep this module App-agnostic, same
// pattern as quicklog.js.
export async function draftChangeRequest({athlete, message, reaction=null, programText="", sourceHint=null, askClaude}){
  const sys = `An athlete asked (or agreed) to send their human coach a program change request. Author the request the coach will read. Return ONLY valid JSON, no markdown:
{"suggested_change":string,"lift":string|null,"current":string|null,"why":string|null,"source":"pain"|"plateau"|"pr"|"feedback"}
suggested_change: ONE concrete, actionable sentence in a coach's voice — what to change and until/unless what — max 140 chars, no preamble. lift: the main exercise involved, or null. current: what the program currently prescribes for that lift, copied from the program text (e.g. "Back Squat 4x5 @ RPE 8"), or null if not found. why: one short plain clause tying the change to what the athlete reported, max 100 chars. source: "pain" if discomfort/injury drove this, "plateau" if a stall did, "pr" if a new max should update loading, else "feedback".`;
  const user = `Athlete: ${athlete?.name||""}\nTheir message/answer: "${message}"\n${reaction?`Coach Joe's reaction: "${reaction}"\n`:""}Current program (first 1200 chars):\n${(programText||"").slice(0,1200)}`;
  let draft = null;
  try{
    const dj = await askClaude(sys, user, 300, [], "claude-haiku-4-5", "change_request_draft");
    draft = JSON.parse(String(dj).replace(/```json|```/g,"").trim());
  }catch(_){ draft = null; } // AI unavailable / bad JSON — full fallback below

  const suggestion = String(draft?.suggested_change||"").trim() || message.slice(0,140);
  const lift = draft?.lift || null;
  const current = draft?.current || null;
  const why = draft?.why || null;
  const source = CR_SOURCES.includes(sourceHint) ? sourceHint
    : (CR_SOURCES.includes(draft?.source) ? draft.source : "feedback");
  return {suggestion, lift, current, why, source};
}

// Files the drafted request to the coach's inbox. sbInsert/track are passed in
// (not imported) for the same App-agnostic reason as draftChangeRequest above.
export async function fileChangeRequest({athlete, draft, reason, sbInsert, track}){
  await sbInsert("program_change_requests",{
    athlete_id: athlete.id,
    coach_id: athlete.coach_id || null,
    items: [{lift: draft.lift||null, suggested_change: draft.suggestion.slice(0,500), current: draft.current||null, why: draft.why||null}],
    reason: reason.slice(0,1000),
    source: draft.source,
  });
  try{ track("change_request_sent","ai"); }catch(_){}
}
