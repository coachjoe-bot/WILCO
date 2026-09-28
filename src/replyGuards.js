// ─── REPLY GUARDS — one voice per turn, no claimed action without the action ─
// T64 S2. Two pure pieces for AI contract rules 5 and 6.
//
// 1. arbitrateFollowUp: the app adds AT MOST ONE bubble per turn after Joe's
//    reply. The priority order lives in FOLLOWUP_PRIORITY below and nowhere
//    else; a lower-priority bubble is dropped (the caller logs it to
//    error_events with the reason), a higher-priority one replaces what showed.
//    Wired in App.jsx send()'s followUp.
//
// 2. claimGuard: finds first-person claims of a program change ("I'm pulling
//    front squat out of the rotation", "I've swapped", "I changed your program")
//    when the turn made no propose_program_rec call and no program write, and
//    replaces those sentences with one truthful line. PURE AND NOT WIRED HERE:
//    S4 wires it inside replyGate (src/replyGate.js) at every settle site.

// ── 1. follow-up arbiter ─────────────────────────────────────────────────────
// Lower rank wins. Action confirmations first (something really happened), then
// a choice the athlete must see to act on (a chip is waiting), then a question,
// then anything else.
export const FOLLOWUP_PRIORITY = Object.freeze({
  action_done: 0,
  choice: 1,
  question: 2,
  info: 3,
});

// Untagged call sites are classified from their own copy, so the table above
// stays the one place the order is written.
export function classifyFollowUp(note) {
  const t = String(note || "").trim();
  if (/Tap [“"]|\b[Ww]ant me to\b|\bWant it\b|\bsay the word\b/i.test(t)) return "choice";
  if (/^(📋|✅|✓|Swapped\b|Saved\b|Added\b|Drafted\b|Staged\b|Program saved\b|Temporary program cleared\b)/.test(t)) return "action_done";
  if (/\?\s*$/.test(t)) return "question";
  return "info";
}

// shown: the bubble already posted this turn ({kind}) or null.
// Returns "show" | "replace" | "drop".
export function arbitrateFollowUp(shown, kind) {
  const k = FOLLOWUP_PRIORITY[kind] != null ? kind : "info";
  if (!shown) return "show";
  const a = FOLLOWUP_PRIORITY[k];
  const b = FOLLOWUP_PRIORITY[shown.kind] != null ? FOLLOWUP_PRIORITY[shown.kind] : FOLLOWUP_PRIORITY.info;
  return a < b ? "replace" : "drop";
}

// ── 2. claim guard ───────────────────────────────────────────────────────────
export const TRUTHFUL_NO_CHANGE = "I haven't changed your program. Say the word and I'll draft it.";

const CHANGE_VERBS = "pull|pulling|swap|swapping|replac(?:e|ing)|remov(?:e|ing)|drop(?:ping)?|tak(?:e|ing)|cut(?:ting)?|mov(?:e|ing)|put(?:ting)?|chang(?:e|ing)|adjust(?:ing)?|add(?:ing)?|sub(?:bing)?|switch(?:ing)?|modify(?:ing)?|rework(?:ing)?|rewrit(?:e|ing)|scal(?:e|ing) back|deload(?:ing)?|program(?:ming)? in";
const PAST_VERBS = "swapped|changed|updated|pulled|removed|replaced|adjusted|dropped|added|moved|cut|switched|modified|rewritten|rewrote|reworked|put|subbed|taken|took|scaled back|deloaded|programmed";
// Words that tie a change verb to the program. S2b (09-28): "for now", "this
// week", "from your program" and a trailing "out" ("I took front squat out.")
// were missing, so past-tense claims slipped through.
const PROGRAMISH = /\b(program|rotation|block|plan|schedule|split|in its place|out of|for the rest|this week(?:'?s)?|next week|for now|monday|tuesday|wednesday|thursday|friday|saturday|sunday|day \d|week \d|going forward|from now on)\b|\bfor an?\b|\bwith an?\b|\bfor (?:a|the)\b|\bfrom (?:your|the|this)\b|\bout(?: for)?\b[.!]?\s*$/i;
// "swapped dips for push-ups": a swap naming its replacement is a program claim
const SWAP_FOR = /\b(swapp|replac|subb|switch)\w*\b[^.!?]*\bfor\b/i;
const NEGATED = /\b(not|nothing|never|no need|no reason|if you want|if you'd like|want me to|say the word|should i|could|would|i'?d)\b|n't\b/i;
const OFF_TOPIC = /\b(memory|remember|note|notes|log|logged|lock screen|card|reminder)\b/i;
// Verbs from the change list used for looking, not changing.
const DESCRIPTIVE = /\b(?:took|take|taking) a (?:look|peek|second|minute|glance)\b|\bpulled up\b|\bput together (?:a|your) (?:summary|recap)\b/i;

// ctx: true = the sentence must also tie the verb to the program (PROGRAMISH or
// a swap naming its replacement); false = the shape alone is a claim.
const CLAIM_RES = [
  { ctx: true, re: new RegExp(`\\b(?:i'?m|i am|we'?re|we are)\\s+(?:(?:going to|gonna|also|now|just)\\s+)?(?:${CHANGE_VERBS})\\b`, "i") },
  { ctx: true, re: new RegExp(`\\b(?:i'?ve|i have|we'?ve|we have|i|we)\\s+(?:(?:just|already|also|now|gone and|went ahead and)\\s+)?(?:${PAST_VERBS})\\b`, "i") },
  // a decision announced as done: "Let's drop front squats from your program going forward."
  { ctx: true, re: new RegExp(`\\blet'?s\\s+(?:just\\s+)?(?:${CHANGE_VERBS})\\b`, "i") },
  { ctx: false, re: /\b(?:your|the) (?:program|plan|block|schedule)\s+(?:is|has been|was|now)\s+(?:updated|changed|adjusted|rewritten|modified|reworked)\b/i },
  { ctx: false, re: /\bi'?ll (?:swap|pull|replace|remove|change|update|adjust|put|move|drop|sub|switch)\b[^.!?]*\b(?:program|rotation|block|in its place)\b/i },
  // "I'm staging a change", "I'm drafting a rec" with no rec staged this turn
  // bare past tense: "I staged a rec for that." (integration, 09-28)
  { ctx: false, re: /\bi\s+(?:just\s+)?(?:staged|drafted|queued|built|wrote|put together)\s+(?:a|an|the|you a)\s+(?:protective\s+|small\s+|quick\s+)?(?:change|rec|recommendation|swap|adjustment|tweak|program change)\b/i },
  // no subject at all: "Front squat's out for now." / "Dips are out of the rotation."
  { ctx: false, re: /\b[a-z][\w' -]{2,40}?(?:'s| is| are)\s+out\s+(?:for now|for (?:the|this) (?:week|block)|of (?:the|your) (?:program|rotation|block|plan))\b/i },
  { ctx: false, re: /\b(?:i'?m|i am|i'?ve|i have)\s+(?:just\s+)?(?:staging|staged|drafting|drafted|putting together|put together|building|built|writing|written|queuing|queued)\s+(?:a|an|the|you a)?\s*(?:protective\s+|small\s+|quick\s+)?(?:change|changes|rec|recommendation|swap|adjustment|tweak|program change)\b/i },
];

export function findClaims(text) {
  const out = [];
  const paras = String(text || "").split(/\n{2,}/);
  paras.forEach((p, pi) => {
    const sents = p.split(/(?<=[.!?])\s+/);
    sents.forEach((s, si) => {
      const clean = s.replace(/[’]/g, "'");
      // a question is an offer, never a claim
      if (NEGATED.test(clean) || OFF_TOPIC.test(clean) || DESCRIPTIVE.test(clean) || /\?\s*$/.test(clean)) return;
      const hit = CLAIM_RES.some(({ re, ctx }) => re.test(clean) && (!ctx || PROGRAMISH.test(clean) || SWAP_FOR.test(clean)));
      if (hit) out.push({ para: pi, sent: si, text: s });
    });
  });
  return out;
}

// toolCalls: the turn's mastermind tool calls ([{name, input}]).
// appWrites: {program: bool} when the app wrote the program this turn.
// Returns {text, changed, removed: [sentences]}.
export function claimGuard(replyText, { toolCalls = [], appWrites = {} } = {}) {
  const text = String(replyText || "");
  const acted = (toolCalls || []).some((tc) => tc && tc.name === "propose_program_rec") || !!(appWrites && (appWrites.program || appWrites.rec));
  if (acted || !text) return { text, changed: false, removed: [] };
  const claims = findClaims(text);
  if (!claims.length) return { text, changed: false, removed: [] };
  const paras = text.split(/\n{2,}/).map((p) => p.split(/(?<=[.!?])\s+/));
  let placed = false;
  for (const c of claims) {
    paras[c.para][c.sent] = placed ? null : TRUTHFUL_NO_CHANGE;
    placed = true;
  }
  const out = paras
    .map((sents) => sents.filter((s) => s !== null).join(" ").trim())
    .filter(Boolean)
    .join("\n\n");
  return { text: out, changed: true, removed: claims.map((c) => c.text) };
}
