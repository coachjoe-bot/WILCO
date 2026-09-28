// ─── THE CHECK-IN AS AN AGENDA (T64 S4) ──────────────────────────────────────
// Will (09-28): the weekly check-in is a normal check-up between an athlete and
// a trainer, with a few questions on the agenda that could go anywhere. Brief.
// No deeper/short-version split. Respond to what they said when it warrants it, then ask the
// next open item when the moment is right; wrap up only when the agenda is
// covered or the athlete ends it. Pain questions keep coming until the area
// clears or the athlete clearly waves it off (the pain ledger decides).
//
// Pure: no React, no network. The modal (ProofChatModal in App.jsx) calls:
//   buildAgenda()          digest questions + ledger records -> open items
//   agendaTurnPrompt()     one model call per athlete message (voice source +
//                          a short check-in instruction), JSON out
//   parseAgendaTurn()      tolerant parse; malformed -> plain reply, agenda unchanged
//   advanceAgenda()        CODE owns the state: covered items, the pending ask,
//                          answers for extraction, and when it ends
//   painStampsFrom()       ledger mark stamps from the pain answers
//   closingLine()          one short deterministic line, never a summary
//
// Server compatibility: the digest's question shape ({id, kind, deeper, meta,
// text}) is unchanged. `deeper` is ignored here (the server may keep emitting it
// for old clients, which still walk the bank by index).

import { JOE_IDENTITY, VOICE_ATHLETE } from "./ai/voice.js";
import { normArea, areaLabel } from "./painLedger.js";

// The digest had no bank at all (legacy digests): the old default, flattened.
export const LEGACY_DEFAULT_QUESTIONS = Object.freeze([
  { id: "working", kind: "context", text: "What felt like it was working?" },
  { id: "off", kind: "context", text: "What felt off or wasn't working?" },
  { id: "injury", kind: "injury", text: "Anything banged up I should know about?" },
  { id: "more_less", kind: "context", text: "Anything you want more of? Less of?" },
]);

export const GENERIC_PAIN_TEXT = "Anything banged up I should know about?";
// At most this many pain areas on one check-in's agenda (brief, Will 09-28).
export const MAX_PAIN_AREAS = 2;
// An item asked this many times without being covered counts as answered by the
// next reply: the check-in never loops on one question.
export const MAX_ASKS_PER_ITEM = 2;

// ── pain question wording (tone comes from the ledger's checkIn) ─────────────
export function painQuestionText(rec) {
  const label = rec?.label || areaLabel(rec?.area) || "that";
  const tone = rec?.checkIn?.tone || "status";
  if (tone === "serious") return `That ${label} sounded serious. Where is it at right now, and has anyone looked at it?`;
  if (tone === "cleared_yet") return `Has the ${label} cleared up?`;
  return `How's the ${label} feeling this week?`;
}
export const painChangeText = (rec) => `Want me to adjust the program around the ${rec?.label || areaLabel(rec?.area) || "area"}, or keep it as written?`;

const areaKeyOf = (meta) => {
  if (!meta) return null;
  if (meta.area_key) return meta.area_key;
  const a = normArea(meta.area || "");
  return a.key || null;
};

// ── 1. the agenda ────────────────────────────────────────────────────────────
// questions: content_json.questions (or null for a legacy digest with none).
// painRecords: painStatus() output computed fresh at check-in time, or null
// when unavailable (the digest's own pain questions then stand as written).
export function buildAgenda(questions, { painRecords = null } = {}) {
  const bank = Array.isArray(questions) ? questions : LEGACY_DEFAULT_QUESTIONS;
  if (!bank.length) return [];                    // a digest with zero questions has no check-in
  const seen = new Set();
  const items = [];
  const recs = Array.isArray(painRecords) ? painRecords : null;
  const recFor = (key) => (recs && key ? recs.find((r) => r.area === key) : null);
  for (const q of bank) {
    if (!q || !q.id || !q.text || seen.has(q.id)) continue;
    seen.add(q.id);
    const item = { id: String(q.id), kind: q.kind || "context", text: String(q.text), meta: q.meta || null };
    if (recs) {
      // the ledger drives pain now: the old catch-all "niggles" question folds into it
      if (item.id === "niggles") continue;
      if (item.kind === "injury" || item.kind === "injury_apply") {
        const key = areaKeyOf(item.meta);
        if (key) {
          const rec = recFor(key);
          if (!rec || !rec.checkIn || !rec.checkIn.ask) continue;                  // cleared, dismissed, or not tracked
          if (item.kind === "injury_apply" && !rec.checkIn.askChange) continue;     // change question stopped or not warranted
          item.pain = { area: rec.area, label: rec.label, tone: rec.checkIn.tone, askChange: !!rec.checkIn.askChange, summary: rec.summary || "" };
          if (item.kind === "injury") item.text = painQuestionText(rec);           // fresh tone (easing -> "has it cleared?")
        } else if (item.kind === "injury") {
          item.pain = { area: null, label: null, tone: "status", askChange: false, summary: "" };
        }
      }
    } else if (item.kind === "injury" || item.kind === "injury_apply") {
      const key = areaKeyOf(item.meta);
      item.pain = { area: key, label: key ? areaLabel(key) : null, tone: "status", askChange: item.kind === "injury_apply", summary: "" };
    }
    items.push(item);
  }
  if (recs) {
    // Areas the ledger says to ask about that the digest did not carry (a flare
    // since the letter was written): add them, up to the cap.
    const have = new Set(items.filter((i) => i.pain && i.pain.area).map((i) => i.pain.area));
    for (const rec of recs) {
      if (have.size >= MAX_PAIN_AREAS) break;
      if (!rec.checkIn || !rec.checkIn.ask || have.has(rec.area)) continue;
      have.add(rec.area);
      const id = `pain_${rec.area}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, kind: "injury", text: painQuestionText(rec), meta: { area: rec.label, area_key: rec.area, tone: rec.checkIn.tone }, pain: { area: rec.area, label: rec.label, tone: rec.checkIn.tone, askChange: !!rec.checkIn.askChange, summary: rec.summary || "" } });
    }
    // An area-specific pain item makes the generic catch-all redundant; with
    // none, the generic question stays (pain is always on the agenda).
    const specific = items.some((i) => i.pain && i.pain.area);
    for (let i = items.length - 1; i >= 0; i--) if (specific && items[i].kind === "injury" && items[i].pain && !items[i].pain.area) items.splice(i, 1);
    if (!items.some((i) => i.kind === "injury")) {
      items.push({ id: items.some((i) => i.id === "injury") ? "injury_generic" : "injury", kind: "injury", text: GENERIC_PAIN_TEXT, meta: null, pain: { area: null, label: null, tone: "status", askChange: false, summary: "" } });
    }
  }
  return items;
}

// ── 2. the per-turn prompt ───────────────────────────────────────────────────
export const CHECKIN_INSTRUCTION = `This is the athlete's check-in: a short, normal conversation between an athlete and their trainer, with a few things on the agenda. It can go anywhere; the agenda comes back when it's natural.
Each turn:
1. Respond first to what they actually said, when it warrants a response: a question gets answered, a story or a concern gets a real reaction. A thin answer ("idk", "fine", "same") gets no forced warmth, just move on.
2. Mark in "covered" every OPEN item their latest message answered, even ones you have not asked yet. Only what the message actually answers.
3. If an item is still open and the moment is right, put ONE of them in "ask", in your own natural words, and its id in "next". Never ask a covered item. If they asked you something that needs room, you may hold it ("ask": null, "next": null).
"reply" is only your response to what they said: it never contains a question. The one question of the turn is "ask". Never ask questions of your own beyond the agenda (no "what's eating your time?"); what they told you is enough.
4. Never restate or summarize their earlier answers back to them, never recap the check-in, never mention an agenda, items or ids.
Bodyweight answers are logged, never judged (no nutrition context exists). Pain follows the PAIN lines exactly: ask the way they say, and never offer a program change unless an open item asks about one.
Return ONLY JSON, no markdown: {"reply": string (may be empty), "ask": string or null, "covered": [ids], "next": id or null, "done": boolean}. "done" is true only when they are clearly ending the check-in.`;

export function agendaTurnPrompt({ agenda = [], covered = [], answers = [], transcript = [], message = "", isMonthly = false, digestNote = "", holdNext = false } = {}) {
  const cov = new Set(covered);
  const open = agenda.filter((i) => !cov.has(i.id));
  const pain = agenda.filter((i) => i.pain && !cov.has(i.id));
  const system = `${JOE_IDENTITY}
VOICE (the app's one voice source):
${VOICE_ATHLETE}

${CHECKIN_INSTRUCTION}${holdNext ? `\nTHIS TURN: do not ask a next item; the app follows up itself after your reply.` : ""}`;
  const lines = [
    `CHECK-IN: ${isMonthly ? "monthly" : "weekly"}.`,
    digestNote ? `THEIR LETTER THIS WEEK (context only): ${digestNote}` : null,
    `OPEN ITEMS:\n${open.length ? open.map((i) => `- ${i.id}: ${i.text}${i.kind !== "context" ? ` [${i.kind}]` : ""}`).join("\n") : "- (none, everything is covered)"}`,
    answers.length ? `ALREADY COVERED (do not ask again, do not repeat back):\n${answers.map((a) => `- ${a.id}`).join("\n")}` : null,
    pain.length ? `PAIN (from the app's pain ledger, final):\n${pain.map((i) => `- ${i.id}: ${i.pain.summary ? `${i.pain.summary} ` : ""}Ask as: "${i.text}"${i.kind === "injury_apply" ? " (the ledger allows offering a change for this area)" : ""}`).join("\n")}` : null,
    `CONVERSATION SO FAR:\n${transcript.slice(-12).map((m) => `${m.role === "user" ? "Athlete" : "Joe"}: ${m.content}`).join("\n") || "(just started)"}`,
    `THEIR LATEST MESSAGE: "${message}"`,
  ].filter(Boolean);
  return { system, user: lines.join("\n\n") };
}

// ── 3. tolerant parse ────────────────────────────────────────────────────────
// Malformed JSON: show a plain reply (the text, or the "reply" field pulled out
// of broken JSON) and leave the agenda unchanged.
export function parseAgendaTurn(raw, openIds = []) {
  const text = String(raw ?? "").replace(/```json|```/g, "").trim();
  const open = new Set(openIds);
  let js = null;
  try { js = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { js = JSON.parse(m[0]); } catch { js = null; } }
  }
  if (!js || typeof js !== "object" || typeof js.reply !== "string") {
    const pulled = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    let reply = pulled ? pulled[1].replace(/\\n/g, "\n").replace(/\\"/g, "\"") : (/^\s*\{/.test(text) ? "" : text);
    return { reply: reply.trim(), covered: [], next: null, done: false, malformed: true };
  }
  const covered = [...new Set((Array.isArray(js.covered) ? js.covered : []).map(String))].filter((id) => open.has(id));
  const coveredSet = new Set(covered);
  const next = js.next != null && open.has(String(js.next)) && !coveredSet.has(String(js.next)) ? String(js.next) : null;
  const ask = next && typeof js.ask === "string" && js.ask.trim() ? js.ask.trim() : null;
  return { reply: String(js.reply).trim(), ask, covered, next, done: js.done === true, malformed: false };
}

// ── 4. the athlete ends it ───────────────────────────────────────────────────
const END_STRONG_RE = /\b(gotta go|got to go|have to go|need to go|i'?m out|end (the |this )?check-?in|stop (the |this )?check-?in|done with (the |this )?check-?in|talk (to you )?later|ttyl|that'?s all for (now|today|this week)|can we (be done|stop|wrap))\b/i;
const END_SHORT_RE = /^\s*(?:(?:nah|nope|no|ok|okay|alright|yeah|yep|cool)[,.!]?\s+)?(that'?s (all|it|everything)|that is all|i'?m (done|good)|im (done|good)|we'?re done|nothing else|no more|all good,? thanks|wrap (it )?up|bye|later|thanks,? (that'?s|thats) (all|it))[\s.!]*$/i;
export const isEndIntent = (msg) => END_STRONG_RE.test(String(msg || "")) || END_SHORT_RE.test(String(msg || ""));

// ── 5. code owns the state ───────────────────────────────────────────────────
// state: {covered:[ids], asked:{id:count}, pending:id|null, answers:[{id,kind,q,a,meta,pain}]}
export const initialAgendaState = (agenda) => ({
  covered: [], asked: agenda.length ? { [agenda[0].id]: 1 } : {}, pending: agenda.length ? agenda[0].id : null, answers: [],
});

// Returns {state, reply, ask: item|null, finished: bool, reason}. `reply` is the
// model's text (gate it before display); `ask` is an item code appends because
// the model left the conversation with nothing to answer.
export function advanceAgenda(agenda, state, { message, parsed, endIntent = false } = {}) {
  const byId = new Map(agenda.map((i) => [i.id, i]));
  const covered = new Set(state.covered);
  const asked = { ...state.asked };
  const answers = [...state.answers];
  const cover = (id) => {
    if (covered.has(id) || !byId.has(id)) return;
    covered.add(id);
    const it = byId.get(id);
    answers.push({ id, kind: it.kind, q: it.text, a: message, meta: it.meta || null, pain: it.pain || null });
  };
  const p = parsed || { reply: "", covered: [], next: null, done: false, malformed: true };
  if (!p.malformed) for (const id of p.covered) cover(id);
  // bounded: the pending item has been asked MAX times and this reply still
  // did not cover it: the reply is its answer, move on
  if (state.pending && !covered.has(state.pending) && (asked[state.pending] || 0) >= MAX_ASKS_PER_ITEM) cover(state.pending);
  // "nah, that's it" right after a question is also its answer
  if (endIntent && state.pending && /^\s*(nah|nope|no)\b/i.test(String(message || ""))) cover(state.pending);
  const openItems = agenda.filter((i) => !covered.has(i.id));
  if (endIntent || !openItems.length) {
    return { state: { covered: [...covered], asked, pending: null, answers }, reply: composeReply(p, null), ask: null, finished: true, reason: openItems.length ? "athlete_ended" : "covered" };
  }
  if (p.malformed) {
    // agenda unchanged; the plain reply shows, the pending ask stands
    return { state: { covered: [...covered], asked, pending: state.pending, answers }, reply: composeReply(p, null), ask: null, finished: false, reason: "malformed" };
  }
  let pending = p.next && !covered.has(p.next) ? p.next : null;
  let ask = null;
  if (!pending) {
    // The model held the next item. When its reply leaves nothing to answer (no
    // question in it) and the athlete did not just ask something, code asks the
    // first open item so the check-in never stalls.
    const athleteAsked = /\?\s*$/.test(String(message || "").trim());
    if (!athleteAsked) { ask = openItems[0]; pending = ask.id; }
  }
  if (pending) asked[pending] = (asked[pending] || 0) + 1;
  // A held turn (no next) keeps the reply's own question only when the athlete
  // just asked something back (a clarifying question is fair there).
  const keepQ = !pending && /\?\s*$/.test(String(message || "").trim());
  return { state: { covered: [...covered], asked, pending, answers }, reply: keepQ ? p.reply : composeReply(p, pending && !ask ? byId.get(pending) : null), ask, finished: false, reason: "continue" };
}

// The turn's text: the reaction (question sentences dropped: the one question
// of a turn is the agenda item) + the model's natural "ask" for the next item.
// Old-shape replies (question inside "reply", no "ask") keep their last question
// when it is the only one, so a model that ignores the split still reads right.
export function composeReply(p, nextItem) {
  const reply = String(p.reply || "").trim();
  const sents = reply.split(/(?<=[.!?])\s+/).filter(Boolean);
  const qs = sents.filter((x) => /\?\s*$/.test(x));
  let reaction = sents.filter((x) => !/\?\s*$/.test(x)).join(" ");
  let ask = p.ask || null;
  if (!ask && p.next && qs.length) ask = qs[qs.length - 1];     // old shape: question lives in reply
  if (!ask && nextItem) ask = nextItem.text;                     // model named next but wrote no question
  if (p.malformed) return reply;                                 // never rewrite a plain fallback
  return [reaction, ask].filter(Boolean).join(" ").trim();
}

// ── 6. pain outcomes -> ledger mark stamps ───────────────────────────────────
const DISMISS_RE = /\b(stop asking|quit asking|don'?t ask|no need to ask|drop it|let it go|leave it alone|not an issue|it'?s nothing|forget (about )?(it|the)|enough about|stop bringing)\b/i;
const CLEARED_RE = /\b(cleared( up)?|all good|feels? (fine|great|good|normal|100)|no (pain|issues?|problems?)|healed|(it'?s |pain'?s )?gone|back to normal|doesn'?t hurt|all better|good now|fine now|good to go|100 ?%)\b/i;
const HEDGE_RE = /\b(still|but|although|though|except|sometimes|a (little|bit|touch)|kinda|kind of|sort of|when i|mostly|not quite|almost)\b/i;
const DECLINE_RE = /\b(no|nah|nope|keep it|leave it|as (it is|written|is)|don'?t change|no change|not now|i'?m good|im good|it'?s fine)\b/i;
const ACCEPT_RE = /\b(yes|yeah|yep|yup|sure|do it|apply|go ahead|change it|please|let'?s do)\b/i;

export function painOutcome(item, answerText) {
  const t = String(answerText || "");
  if (DISMISS_RE.test(t)) return "dismissed";
  if (item.kind === "injury_apply") {
    if (ACCEPT_RE.test(t) && !/\b(no|nah|nope)\b/i.test(t)) return "accepted_change";
    if (DECLINE_RE.test(t)) return "declined_change";
    return null;
  }
  if (CLEARED_RE.test(t) && !HEDGE_RE.test(t)) return "cleared";
  return "answered";
}

// state.asked: ids the check-in asked (pending at some point); state.covered /
// state.answers: the covered items with the message that covered them.
export function painStampsFrom({ agenda = [], state = null } = {}) {
  if (!state) return [];
  const stamps = [];
  const byId = new Map(agenda.map((i) => [i.id, i]));
  const push = (area, field) => { if (area && !stamps.some((s) => s.area === area && s.field === field)) stamps.push({ area, field }); };
  // asked_at: the check-in touched this area this week, asked or answered unprompted
  for (const id of [...Object.keys(state.asked || {}), ...(state.covered || [])]) {
    const it = byId.get(id);
    if (it && it.pain && it.pain.area) push(it.pain.area, "asked_at");
  }
  for (const a of state.answers || []) {
    const it = byId.get(a.id);
    if (!it || !it.pain || !it.pain.area) continue;
    const out = painOutcome(it, a.a);
    if (out === "dismissed") push(it.pain.area, "dismissed_at");
    else if (out === "cleared") push(it.pain.area, "cleared_at");
    else if (out === "declined_change") push(it.pain.area, "declined_change");
  }
  return stamps;
}

// ── 7. closing: one short deterministic line, never a summary ────────────────
export function closingLine({ recParked = false, early = false } = {}) {
  if (recParked) return "Got it. The program change we talked about is waiting in Drafts, under Program, Memory.";
  if (early) return "No problem, we'll pick it up next week.";
  return "That's it for this week. Keep putting in the work.";
}

// A short plain note of the letter for the model's context (never the whole JSON).
export function digestNoteFrom(sections = []) {
  return (Array.isArray(sections) ? sections : [])
    .slice(0, 6)
    .map((s) => `${s.label}: ${String(s.body || "").replace(/\s+/g, " ").slice(0, 180)}`)
    .join(" | ");
}
