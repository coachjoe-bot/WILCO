// ─── MEMORY: THE ATHLETE'S OWN EDITS (T69-A) ─────────────────────────────────
// Will, 10-01: "I want to be able to directly edit the text. I don't want to
// have to talk to Coach Joe at the bottom about it at all." This reverses the
// 09-01 ruling (every edit proofread by the AI). An athlete now taps a line in
// Program, Memory, Athlete Context and types. No AI call sits between their
// keyboard and the store, so every rule that keeps memory safe runs HERE, in
// code, on every save:
//   • validateFact (src/memory.js) is still the one validator. It refuses
//     behavior instructions, pain tallies, program-change claims, block end
//     dates, empty text and anything past the 2000-char abuse bound.
//   • An edit keeps the row: same id, same kind, same expiry. Only the text
//     and its source change.
//   • "Watching:" notes are written by the app (src/recs.js) and that prefix
//     exempts a line from the ledger rules, so an athlete can delete one but
//     can never type one.
//   • The row cap is the same rule planMemoryOps uses: at 60 the oldest
//     unpinned fact gives way.
// Pure: returns the same action list applyMemoryActions already executes.
import { validateFact, findDuplicate, activeFacts, matchFacts, behaviorRejects, cleanText, MEMORY_ROW_CAP } from "./memory.js";
import { expiryFromText, NEEDS_DATE } from "./noteDates.js";
import { isNoteSection, resolveSection } from "./memorySections.js";

// What the athlete typed with their own hands, as opposed to a fact Joe wrote
// from something they said (athlete_said) or the app inferred (inferred).
// TWIN: api/data.js ATHLETE_COL_ALLOW.athlete_memory.values.source and the DB
// CHECK athlete_memory_source_check must both list this value.
export const TYPED_SOURCE = "athlete_typed";

const WATCH_RE = /^\s*watching\s*:/i;
const squash = (s) => cleanText(s).replace(/\s+/g, " ").trim();

// One short human line per refusal. Athlete-facing copy: plain, no em dashes.
const REFUSAL_LINES = {
  empty: "Nothing to save. Type the note first.",
  too_long: "That is too long for one note. Keep it under 2,000 characters.",
  behavior_instruction: "Notes hold facts about you. That one reads like an instruction for Joe.",
  pain_tally: "Pain counts are tracked by the app from what you log, so they are not kept as a note.",
  program_claim: "A note can't change your program. Edit it on the Program tab, or ask Joe for a program change.",
  block_end_date: "When your program ends is saved on the program itself, not as a note. Tell Joe the end date and the app sets it.",
  duplicate: "You already have that note.",
  gone: "That note is gone. It expired or was removed.",
  reserved: "Notes starting with \"Watching:\" are written by the app. Reword it.",
  watch_note: "The app wrote this one to keep an eye on something. You can delete it, but it can't be rewritten.",
  full: "Memory is full of pinned notes. Delete one first.",
  needs_date: "Use the actual date (like Oct 12) instead of words like tomorrow or next week, so the note can drop off by itself when the day passes.",
};
export const refusalLine = (reason) => REFUSAL_LINES[reason] || "Couldn't save that one. Try again.";

const refuse = (reason) => ({ ok: false, reason, message: refusalLine(reason) });

// Tap a fact, change its text, Save.
export function planDirectEdit(rows, id, text, now = new Date()) {
  const live = activeFacts(rows, now);
  const row = live.find((r) => String(r.id) === String(id));
  if (!row) return refuse("gone");
  if (WATCH_RE.test(row.content)) return refuse("watch_note");
  if (WATCH_RE.test(text)) return refuse("reserved");
  const v = validateFact({ content: text, kind: row.kind, expires_at: row.expires_at });
  if (!v.ok) return v.reason === "empty" ? { ...refuse("empty"), message: "A note can't be blank. Use Delete to remove it." } : refuse(v.reason);
  if (v.content === squash(row.content)) return { ok: true, unchanged: true, actions: [] };
  if (findDuplicate(live.filter((r) => r.id !== row.id), v.content)) return refuse("duplicate");
  // T69-C: changing a note is checking it. The 3 to 8 week clock restarts.
  return { ok: true, actions: [{ type: "update", id: row.id, data: { content: v.content, source: TYPED_SOURCE, ...stampNow(now) } }] };
}

// T69-C: a note the athlete just wrote or changed counts as checked today.
const stampNow = (now) => ({ confirmed_at: new Date(now).toISOString(), ask_count: 0 });

// "Add a note": a contextual fact. A note that names a calendar date expires on
// it without asking (src/noteDates.js); one that says "tomorrow" or "next week"
// with no date is refused, so it can never go stale unreviewed (Will's 08-09
// goal row). opts.section files it under a tab section; with none, code files
// it by its words (the tab's bottom "+ Add a note" asks Joe's scan instead).
export function planDirectAdd(rows, text, now = new Date(), opts = {}) {
  if (WATCH_RE.test(text)) return refuse("reserved");
  const exp = expiryFromText(text, now);
  const kind = exp ? "situational" : "contextual";
  const v = validateFact({ content: text, kind, expires_at: exp, now });
  if (!v.ok) return refuse(v.reason);
  const live = activeFacts(rows, now);
  if (findDuplicate(live, v.content)) return refuse("duplicate");
  const actions = [];
  if (live.length >= MEMORY_ROW_CAP) {
    const victim = live.filter((x) => x.kind !== "pinned")
      .sort((a, b) => Date.parse(a.updated_at || a.created_at || 0) - Date.parse(b.updated_at || b.created_at || 0))[0];
    if (!victim) return refuse("full");
    actions.push({ type: "update", id: victim.id, data: { status: "deleted" } });
  }
  const section = isNoteSection(opts.section) ? opts.section : resolveSection({ content: v.content, kind, expires_at: exp }, now);
  const data = { content: v.content, kind, expires_at: exp, source: TYPED_SOURCE, section, ...stampNow(now) };
  if (opts.areaKey) data.area_key = String(opts.areaKey).slice(0, 40);
  actions.push({ type: "insert", data });
  return { ok: true, actions };
}

// Delete is always allowed, watch notes included. A row that is already gone
// is a no-op, never an error and never a second write.
export function planDirectDelete(rows, id, now = new Date()) {
  const row = activeFacts(rows, now).find((r) => String(r.id) === String(id));
  if (!row) return { ok: true, unchanged: true, actions: [] };
  return { ok: true, actions: [{ type: "update", id: row.id, data: { status: "deleted" } }] };
}

// ── goal and injury notes ────────────────────────────────────────────────────
// Both are typed by the athlete and both ride in Joe's context every turn, so
// the instruction guard applies to them too. They are not memory facts: a goal
// is a row in athlete_goals written through writeAthleteGoal, and injury notes
// are athletes.injury_history (undated background; what hurts NOW is the pain
// ledger's, never this field).
export const GOAL_MAX_LEN = 300;
export const INJURY_MAX_LEN = 1000;

const GOAL_LINES = {
  empty: "Type your goal first.",
  too_short: "Give Joe a little more to work with.",
  too_long: "Keep the goal to a sentence or two.",
  behavior_instruction: "A goal is what you are training for. That one reads like an instruction for Joe.",
};
export function validateGoalText(text) {
  const t = squash(text);
  const no = (reason) => ({ ok: false, reason, message: GOAL_LINES[reason] });
  if (!t) return no("empty");
  if (t.length < 4) return no("too_short");
  if (t.length > GOAL_MAX_LEN) return no("too_long");
  if (behaviorRejects(t)) return no("behavior_instruction");
  return { ok: true, text: t };
}

const INJURY_LINES = {
  too_long: "Keep this under 1,000 characters.",
  behavior_instruction: "This holds your injury history. That reads like an instruction for Joe.",
};
// Empty is allowed: it clears the section.
export function validateInjuryText(text) {
  const t = cleanText(text).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const no = (reason) => ({ ok: false, reason, message: INJURY_LINES[reason] });
  if (t.length > INJURY_MAX_LEN) return no("too_long");
  if (t && behaviorRejects(t)) return no("behavior_instruction");
  return { ok: true, text: t || null };
}

// ── Joe's hands on the same stores (chat) ────────────────────────────────────
// "In chat they should be able to say 'update my memory to this' and Joe
// should do it for them" (Will 10-01). Joe calls a tool; these planners are
// the code that validates the call before anything is written, and the outcome
// line is the app's ONE truthful confirmation, posted only after the writes
// finished (AI contract rules 5 and 6). A refused call says so in plain words,
// so "noted" in Joe's reply can never stand in for a write that did not happen.
export const MEMORY_TOOL_NAMES = ["remember_fact", "forget_fact", "update_fact", "set_goal", "set_injury_notes"];
export const isMemoryTool = (name) => MEMORY_TOOL_NAMES.includes(name);

// update_fact: one fact changed in place (same row, same kind, same expiry).
// A match that does not land on exactly one editable fact never guesses: the
// new text is saved as its own fact, so what the athlete said still lands.
export function planToolUpdate(rows, match, content, now = new Date()) {
  const live = activeFacts(rows, now);
  const m = matchFacts(rows, match, now);
  const hits = m.ok ? m.rows.filter((r) => !WATCH_RE.test(r.content)) : [];
  if (WATCH_RE.test(content)) return refuse("reserved");
  if (hits.length !== 1) {
    const exp = expiryFromText(content, now);
    const v = validateFact({ content, kind: exp ? "situational" : "contextual", expires_at: exp, now });
    if (!v.ok) return refuse(v.reason);
    if (findDuplicate(live, v.content)) return { ok: true, unchanged: true, actions: [] };
    return { ok: true, added: true, actions: [{ type: "insert", data: { content: v.content, kind: exp ? "situational" : "contextual", expires_at: exp, source: "athlete_said", section: resolveSection({ content: v.content, expires_at: exp, kind: exp ? "situational" : "contextual" }, now), ...stampNow(now) } }] };
  }
  const row = hits[0];
  const v = validateFact({ content, kind: row.kind, expires_at: row.expires_at, now });
  if (!v.ok) return refuse(v.reason);
  if (v.content === squash(row.content)) return { ok: true, unchanged: true, actions: [] };
  // Another fact already says the new thing: the stale one just goes.
  if (findDuplicate(live.filter((r) => r.id !== row.id), v.content)) return { ok: true, actions: [{ type: "update", id: row.id, data: { status: "deleted" } }] };
  return { ok: true, actions: [{ type: "update", id: row.id, data: { content: v.content, source: "athlete_said", ...stampNow(now) } }] };
}

// remember_fact (T69-C): the same save Joe always made, now sectioned, stamped
// and date-safe. A note with a calendar date expires on it; "tomorrow" with no
// expires_at is refused (the card tells Joe to write the date; the app's own
// "Not saved" line tells the athlete when he did not). Returns the actions
// applyMemoryActions runs.
export function planToolRemember(rows, inp = {}, now = new Date()) {
  const kind = inp.kind;
  const exp = inp.expires_at || (kind !== "pinned" ? expiryFromText(inp.content, now) : null);
  const v = validateFact({ content: inp.content, kind, expires_at: exp, now });
  if (!v.ok) return refuse(v.reason);
  const live = activeFacts(rows, now);
  const dup = findDuplicate(live, v.content);
  if (dup) return { ok: true, actions: [{ type: "update", id: dup.id, data: { kind, expires_at: exp || null, ...stampNow(now) } }], saved: true };
  const section = isNoteSection(inp.section) ? inp.section : resolveSection({ content: v.content, kind, expires_at: exp }, now);
  return { ok: true, saved: true, actions: [{ type: "insert", data: { content: v.content, kind, expires_at: exp || null, source: "athlete_said", section, ...stampNow(now) } }] };
}

// Bodyweight has one home, athletes.weight_lbs (AI contract rule 2). On main a
// "update my memory: I weigh 170 now" saved a memory fact 5 of 5 and left the
// profile at the old weight. When the app saved a stated bodyweight this turn,
// a fact that only restates it is dropped.
export const isBodyweightFact = (content) => {
  const t = String(content || "");
  return /\b(body ?weight|weighs?|weigh(?:ing|ed)? in|on the scale)\b/i.test(t) && /\d/.test(t) && t.length <= 120;
};

export const newMemoryOutcome = () => ({ saved: 0, updated: 0, removed: 0, goal: false, injury: false, refused: [] });

// The app's one confirmation for a turn's memory writes. "" = nothing to say.
export function memoryOutcomeLine(out) {
  const o = out || newMemoryOutcome();
  const memKinds = (o.saved ? 1 : 0) + (o.updated ? 1 : 0) + (o.removed ? 1 : 0);
  const parts = [];
  if (o.goal) parts.push("goal");
  if (o.injury) parts.push("injury notes");
  if (memKinds) parts.push("memory");
  let done = "";
  if (parts.length === 1) {
    if (o.goal) done = "✓ Goal updated.";
    else if (o.injury) done = "✓ Injury notes updated.";
    else if (memKinds > 1 || o.updated) done = "✓ Memory updated.";
    else if (o.saved) done = "✓ Saved to memory.";
    else done = "✓ Removed from memory.";
  } else if (parts.length > 1) {
    done = `✓ Updated your ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
  }
  // A forget that matched nothing only matters when nothing else happened.
  const real = (o.refused || []).filter((r) => r && r.message && !(done && r.reason === "no_match"));
  if (!real.length) return done;
  const why = real[0].message;
  return done ? `${done} One part was not saved. ${why}` : `Not saved. ${why}`;
}
export const toolRefusal = (reason) => ({
  reason,
  message: reason === "no_match" ? "Couldn't find that note in your memory. Open Program, Memory to see what is there."
    : reason === "error" ? "Something went wrong saving it. Try again."
    : refusalLine(reason),
});
