// ─── MEMORY REVIEW (T69-C): which old notes the check-in asks about ──────────
// Will, 10-01 and 10-02: the weekly check-in removes old information as well as
// adding new. This module is the ONE queue: notes, the goal, and the three
// signup fields the athlete told us once, in, and the ordered list of what to
// ask this check-in out, each with its plain reason. Rules (Will's words):
//   - "Any note that has not been asked about in 3 to 8 weeks comes up." The
//     exact day inside the window is fixed per note from its id (stable, and
//     spread out). Rows with no stamp (everything before this shipped) are spread
//     across the 8 weeks after rollout by the same id rule: never a wave.
//   - "At most FOUR per check-in; the most overdue go first, the rest wait a
//     week." Bodyweight is asked every week as today and is outside the cap.
//   - Jump the line, in this order: a note the logs disagree with (training days
//     against sessions logged in the last 3 weeks; a goal lift not trained in 4
//     weeks), a goal with no date or a date within 21 days or past, a signup field
//     never checked. Then most overdue. A jumper still waits out the 3-week
//     minimum after its last check, so it can never be asked every week.
//   - Never asked: Bio, pinned notes, live lines, a note with an expiry or a
//     calendar date (it drops on its date), watch notes, anything in This week,
//     the retired check-in summaries.
//   - "A note asked twice with no answer is removed. Skipping a whole check-in
//     does not count against a note." A counter moves only when the question was
//     put to the athlete AND they replied without answering it.
//   - A work-around note tied to a pain area is never asked while the area is
//     open (pain is raised only as often as the pain ledger allows: the note rides
//     the ledger's own question). When the ledger reads the area cleared it jumps
//     the line once.
// Pure: no I/O, no React. Suite: scripts/test-memory-review.mjs.
import { activeFacts, validateFact, UNANSWERED_TO_REMOVE } from "./memory.js";
export { UNANSWERED_TO_REMOVE };
import { isWatchNote, isLegacyCheckinNote, resolveSection, SECTION_LABEL } from "./memorySections.js";
import { isDatedEvent, noteSpan } from "./noteDates.js";
import { activeGoals } from "./goals.js";
import { goalTargets, resolveLift, isRealSession } from "./grit.js";
import { areaLabel, rowDay } from "./painLedger.js";

export const REVIEW_MIN_DAYS = 21;          // 3 weeks: the earliest a checked note comes up again
export const REVIEW_MAX_DAYS = 56;          // 8 weeks: the latest
export const MAX_REVIEW_PER_CHECKIN = 4;
export const LOGS_WINDOW_DAYS = 21;         // training days vs sessions logged over the last 3 weeks
export const GOAL_LIFT_IDLE_DAYS = 28;      // a goal lift not trained in 4 weeks
export const GOAL_DATE_NEAR_DAYS = 21;
// The day the review starts for rows that have no stamp. Everything older is
// "legacy": it is spread over the 8 weeks after this day. Fixed at build time
// (it is the week this ships), never "now", so the spread does not move.
export const REVIEW_ROLLOUT = "2026-10-05";
export const SIGNUP_FIELDS = ["training_days_per_week", "equipment", "injury_history"];
export const EQUIPMENT_OPTIONS = ["Full gym", "Barbells & racks", "Dumbbells only", "Bodyweight only", "Home gym (mixed)"];

const DAY = 86400000;
const ts = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

// FNV-1a: small, deterministic, no dependency. The same id always lands on the
// same day, so what is due next week does not reshuffle when notes are added.
export function hashId(str) {
  let h = 0x811c9dc5;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export const windowDays = (id) => REVIEW_MIN_DAYS + (hashId(`w|${id}`) % (REVIEW_MAX_DAYS - REVIEW_MIN_DAYS + 1));
export const legacyOffsetDays = (id) => hashId(`l|${id}`) % REVIEW_MAX_DAYS;

// When is a thing due, and from when may a jumper pull it forward?
// stamp: confirmed_at; created: created_at (or the athlete's signup date).
export function schedule({ id, stamp, created, rollout = REVIEW_ROLLOUT }) {
  const r = ts(rollout);
  if (stamp != null) return { dueAt: stamp + windowDays(id) * DAY, eligibleAt: stamp + REVIEW_MIN_DAYS * DAY, legacy: false };
  const c = created != null ? created : r;
  if (c < r) return { dueAt: Math.max(r + legacyOffsetDays(id) * DAY, c + REVIEW_MIN_DAYS * DAY), eligibleAt: r, legacy: true };
  return { dueAt: c + windowDays(id) * DAY, eligibleAt: c + REVIEW_MIN_DAYS * DAY, legacy: false };
}

// ── what the logs say ────
// Real sessions as {day, lifts:[canonical lift ids]}, one per training day. The
// caller supplies rows that cover the last 28 days (the server's batch window,
// or the client's dedicated read): never the newest-100 history, which counts
// chat messages and would undercount a chatty athlete.
export function sessionDays(rows, { tz } = {}) {
  const byDay = new Map();
  for (const w of rows || []) {
    if (!isRealSession(w)) continue;
    const day = rowDay(w, tz);
    if (!day) continue;
    const pdata = typeof w.parsed_data === "string" ? (() => { try { return JSON.parse(w.parsed_data); } catch { return {}; } })() : (w.parsed_data || {});
    const set = byDay.get(day) || new Set();
    for (const ex of pdata.exercises || []) if (ex && ex.name) set.add(resolveLift(ex.name).id);
    byDay.set(day, set);
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, set]) => ({ day, lifts: [...set] }));
}
// sessions: [{day:"YYYY-MM-DD", lifts:[liftId,...]}], real sessions only, one
// per training day, covering at least the last 28 days.
const dayMs = (k) => Date.parse(`${k}T12:00:00Z`);
const todayKey = (now) => new Date(now).toISOString().slice(0, 10);
export function weeklyCounts(sessions, now = new Date(), weeks = 3) {
  const today = dayMs(todayKey(now));
  const out = Array(weeks).fill(0);
  const seen = new Set();
  for (const s of sessions || []) {
    if (!s || !s.day || seen.has(s.day)) continue;
    seen.add(s.day);
    const ago = Math.floor((today - dayMs(s.day)) / DAY);
    if (ago < 0 || ago >= weeks * 7) continue;
    out[weeks - 1 - Math.floor(ago / 7)]++;
  }
  return out;                                   // oldest week first: [2, 3, 2]
}
// Training days vs what was logged. Needs a real window (the account is at
// least 3 weeks old) and at least one logged session; a gap of 2 or more
// sessions a week, either way, is a disagreement.
export function logsDisagree({ declared, sessions, now = new Date(), createdAt = null }) {
  const n = Number(declared);
  if (!Number.isFinite(n) || n < 1) return { disagree: false };
  const created = ts(createdAt);
  if (created != null && new Date(now).getTime() - created < LOGS_WINDOW_DAYS * DAY) return { disagree: false };
  const weeks = weeklyCounts(sessions, now, 3);
  const total = weeks.reduce((a, b) => a + b, 0);
  if (total < 1) return { disagree: false, weeks };
  const avg = total / 3;
  return { disagree: Math.abs(n - avg) >= 2, weeks, avg };
}
// A goal lift (from the goal's parsed targets) with no session in 4 weeks.
export function goalLiftIdle({ goal, sessions, now = new Date(), createdAt = null }) {
  const ids = [...new Set(goalTargets(goal).map((t) => resolveLift(t.lift).id))];
  if (!ids.length) return { idle: false };
  const created = ts(createdAt);
  if (created != null && new Date(now).getTime() - created < GOAL_LIFT_IDLE_DAYS * DAY) return { idle: false };
  const today = dayMs(todayKey(now));
  const trained = (sessions || []).some((s) => s && s.day && Math.floor((today - dayMs(s.day)) / DAY) < GOAL_LIFT_IDLE_DAYS && (s.lifts || []).some((l) => ids.includes(l)));
  return { idle: !trained, lifts: ids };
}

// ── plain words ──────────────────────────────────────────────────────────────
const clip = (s, n = 130) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 3).trimEnd()}...` : t; };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (ms) => { const d = new Date(ms); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const list = (a) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const lc = (s) => String(s || "").replace(/^./, (c) => c.toLowerCase());

const REASON_LINE = {
  logs_disagree: "your logs disagree with the note",
  goal_lift_idle: "you have not trained that lift in 4 weeks",
  goal_no_date: "the goal has no date",
  goal_date_near: "the goal date is close",
  goal_date_past: "the goal date has passed",
  older_goal: "an older goal is still on file",
  never_checked: "not checked since you told me",
  workaround_cleared: "the pain tracker reads it cleared",
  window: "due for a check",
};
const reasonLine = (reason, ctx = {}) => {
  if (reason === "window" && ctx.checkedMs) return `last checked ${fmtDay(ctx.checkedMs)}`;
  if (reason === "window" && ctx.savedMs) return `saved ${fmtDay(ctx.savedMs)}, not checked since`;
  return REASON_LINE[reason] || REASON_LINE.window;
};

function noteQuestion(row, reason) {
  const q = clip(row.content);
  if (reason === "workaround_cleared") return null; // built with the area
  return `I have a note that says "${q}". Is that still true?`;
}

// ── the queue ────────────────────────────────────────────────────────────────
const JUMP = { logs_disagree: 1, goal_lift_idle: 1, goal_no_date: 2, goal_date_near: 2, goal_date_past: 2, older_goal: 2, never_checked: 3, workaround_cleared: 1 };
const idOf = (type, ref) => `review_${type}_${ref}`;

export function reviewQueue({ notes = [], goals = [], athlete = {}, sessions = [], pain = null, now = new Date(), rollout = REVIEW_ROLLOUT, cap = MAX_REVIEW_PER_CHECKIN } = {}) {
  const nowMs = new Date(now).getTime();
  const painBy = new Map((Array.isArray(pain) ? pain : []).map((r) => [r.area, r]));
  const cand = [];

  // 1. notes
  for (const row of activeFacts(notes, now)) {
    if (row.kind === "pinned" || isWatchNote(row) || isLegacyCheckinNote(row)) continue;
    if (resolveSection(row, now) === "this_week") continue;
    const stamp = ts(row.confirmed_at);
    const created = ts(row.created_at);
    const sched = schedule({ id: row.id, stamp, created, rollout });
    const rec = row.area_key ? painBy.get(row.area_key) : null;
    // a work-around note
    if (row.area_key && rec) {
      if (rec.state !== "cleared") continue;                                  // the ledger's own question carries it
      const clearedMs = rec.clearedOn ? dayMs(rec.clearedOn) : nowMs;
      const checkedSince = stamp != null && stamp >= clearedMs;
      if (checkedSince) { cand.push({ type: "note", ref: row.id, row, sched, jump: null, reason: "window" }); continue; }
      cand.push({ type: "workaround", ref: row.id, row, sched: { ...sched, dueAt: nowMs, eligibleAt: nowMs }, jump: JUMP.workaround_cleared, reason: "workaround_cleared", rec });
      continue;
    }
    if (isDatedEvent(row, now)) continue;                                     // drops on its date, never asked
    cand.push({ type: "note", ref: row.id, row, sched, jump: null, reason: "window" });
  }

  // 2. goals: the newest live row is THE goal; older live rows are asked about
  const live = activeGoals(goals, now).slice().sort((a, b) => (ts(b.created_at) || 0) - (ts(a.created_at) || 0));
  const current = live[0] || null;
  if (current) {
    const stamp = ts(current.confirmed_at);
    const sched = schedule({ id: current.id, stamp, created: ts(current.created_at), rollout });
    const dateMs = current.target_date ? ts(current.target_date) : null;
    const days = dateMs != null ? Math.round((dateMs - nowMs) / DAY) : null;
    let reason = "window", jump = null;
    const idle = goalLiftIdle({ goal: current, sessions, now, createdAt: current.created_at });
    if (idle.idle) { reason = "goal_lift_idle"; jump = JUMP.goal_lift_idle; }
    else if (dateMs == null) { reason = "goal_no_date"; jump = JUMP.goal_no_date; }
    else if (days < 0) { reason = "goal_date_past"; jump = JUMP.goal_date_past; }
    else if (days <= GOAL_DATE_NEAR_DAYS) { reason = "goal_date_near"; jump = JUMP.goal_date_near; }
    cand.push({ type: "goal", ref: current.id, goal: current, sched, jump, reason, days });
  }
  for (const g of live.slice(1).reverse()) {                                  // oldest first: the stalest goes first
    const stamp = ts(g.confirmed_at);
    cand.push({ type: "goal", ref: g.id, goal: g, older: true, sched: schedule({ id: g.id, stamp, created: ts(g.created_at), rollout }), jump: JUMP.older_goal, reason: "older_goal", current });
  }

  // 3. the three signup fields
  const stamps = athlete.review_stamps && typeof athlete.review_stamps === "object" ? athlete.review_stamps : {};
  const signupCreated = ts(athlete.created_at);
  for (const field of SIGNUP_FIELDS) {
    const v = athlete[field];
    const has = field === "equipment" ? Array.isArray(v) && v.length > 0 : field === "injury_history" ? String(v || "").trim().length > 0 : Number(v) >= 1;
    if (!has) continue;
    const st = stamps[field] || {};
    const stamp = ts(st.confirmed_at);
    const sched = schedule({ id: `signup_${field}`, stamp, created: signupCreated, rollout });
    let reason = stamp == null ? "never_checked" : "window", jump = stamp == null ? JUMP.never_checked : null, weeks = null;
    if (field === "training_days_per_week") {
      const d = logsDisagree({ declared: v, sessions, now, createdAt: athlete.created_at });
      if (d.disagree) { reason = "logs_disagree"; jump = JUMP.logs_disagree; weeks = d.weeks; }
    }
    cand.push({ type: "signup", ref: field, field, value: v, sched, jump, reason, weeks, ask_count: Number(st.ask_count) || 0, stamp, signupCreated });
  }

  // 4. due, then order: jumpers (by rank, then most overdue), then the rest by most overdue
  const due = [];
  for (const c of cand) {
    const plainDue = nowMs >= c.sched.dueAt;
    const jumpDue = c.jump != null && nowMs >= c.sched.eligibleAt;
    if (!plainDue && !jumpDue) continue;
    due.push({ ...c, overdue: (nowMs - c.sched.dueAt) / DAY, jumped: c.jump != null && jumpDue });
  }
  due.sort((a, b) => {
    const ja = a.jumped ? a.jump : 99, jb = b.jumped ? b.jump : 99;
    if (ja !== jb) return ja - jb;
    if (a.overdue !== b.overdue) return b.overdue - a.overdue;
    return String(a.ref) < String(b.ref) ? -1 : 1;
  });

  // the older-goal question: one per check-in, never several goals at once
  let olderTaken = false;
  const picked = [];
  for (const c of due) {
    if (c.older) { if (olderTaken) continue; olderTaken = true; }
    picked.push(c);
  }
  const items = picked.slice(0, cap).map((c) => toItem(c, { now, athlete }));
  return { items, overflow: Math.max(0, picked.length - cap), dueCount: picked.length, current: current ? { id: current.id } : null };
}

// ── one candidate -> the agenda item the check-in walks ──────────────────────
function toItem(c, { now, athlete }) {
  const base = { rid: null, type: c.type, ref: c.ref, reason: c.reason, jump: c.jumped ? c.jump : null, overdue: Math.round(c.overdue * 10) / 10 };
  if (c.type === "note") {
    const row = c.row;
    const section = resolveSection(row, now);
    const tag = reasonLine(c.reason, { checkedMs: ts(row.confirmed_at), savedMs: ts(row.created_at) });
    return { ...base, rid: idOf("note", row.id), kind: "memory", section, note: row.content, text: noteQuestion(row, c.reason), tag: { section: SECTION_LABEL[section] || "Notes", label: tag } };
  }
  if (c.type === "workaround") {
    const row = c.row;
    const label = areaLabel(c.rec.area);
    return { ...base, rid: idOf("note", row.id), kind: "memory", section: "body", note: row.content, area: c.rec.area,
      text: `Your ${label} reads cleared now. You had been working around it: "${clip(row.content, 100)}". Do those lifts come back?`,
      tag: { section: "Body", label: REASON_LINE.workaround_cleared } };
  }
  if (c.type === "goal") {
    const g = c.goal;
    if (c.older) {
      return { ...base, rid: idOf("goal", g.id), kind: "goal", section: "goal", note: g.goal_text, older: true,
        text: `You also still have an older goal on file: "${clip(g.goal_text, 120)}", from ${fmtDay(ts(g.created_at) || Date.now())}. Is that one done, or still part of what you are chasing?`,
        tag: { section: "Goal", label: REASON_LINE.older_goal } };
    }
    let text = null;
    if (c.reason === "goal_no_date") text = `Your goal has no date: "${clip(g.goal_text, 120)}". Still the target, and is there a date you are aiming for?`;
    else if (c.reason === "goal_lift_idle") text = `Your goal is "${clip(g.goal_text, 120)}", and I do not see that lift in your last 4 weeks. Still the target?`;
    return { ...base, rid: idOf("goal", g.id), kind: "goal", section: "goal", note: g.goal_text, text, merge: "goal",
      tag: { section: "Goal", label: reasonLine(c.reason, {}) } };
  }
  // signup fields
  const f = c.field;
  const section = f === "injury_history" ? "body" : "schedule";
  let text;
  if (f === "training_days_per_week") {
    text = c.reason === "logs_disagree" && c.weeks
      ? `I have you down as training ${c.value} days a week, and your last three weeks were ${c.weeks[0]}, ${c.weeks[1]} and ${c.weeks[2]} sessions. Is ${c.value} still the plan?`
      : `I have you training ${c.value} days a week. Is that still right?`;
  } else if (f === "equipment") {
    text = `I have your training setup as ${list(c.value.map(lc))}. Is that still right?`;
  } else {
    text = `From signup I still have "${clip(c.value, 120)}". Is that still true?`;
  }
  const signed = athlete && athlete.created_at ? fmtDay(Date.parse(athlete.created_at)) : null;
  const label = c.reason === "never_checked" ? `not checked since signup${signed ? ` (${signed})` : ""}` : reasonLine(c.reason, { checkedMs: c.stamp });
  return { ...base, rid: idOf("signup", f), kind: "memory", section, field: f, note: Array.isArray(c.value) ? c.value.join(", ") : String(c.value), text, tag: { section: SECTION_LABEL[section], label } };
}

// ── what the answer does ─────────────────────────────────────────────────────
// targets: [{rid, type, ref, older?, asked, covered}] from the agenda and the
// check-in state (see targetsFrom in src/checkinAgenda.js). verdicts: the
// extractor's `review` array, by rid. Returns every write as data. Code, never
// the model, decides what each verdict does; nothing reaches a table unshaped.
const VERDICTS = ["keep", "edit", "remove", "unclear"];
export function readVerdicts(raw) {
  const out = {};
  for (const v of Array.isArray(raw) ? raw : []) {
    if (!v || typeof v !== "object" || !v.id || !VERDICTS.includes(v.verdict)) continue;
    out[String(v.id)] = { verdict: v.verdict, content: typeof v.content === "string" ? v.content : null, value: v.value === undefined ? null : v.value, expires_at: v.expires_at || null };
  }
  return out;
}

export function validateSignupValue(field, value) {
  if (field === "training_days_per_week") {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 && n <= 7 ? { ok: true, value: n } : { ok: false };
  }
  if (field === "equipment") {
    const arr = (Array.isArray(value) ? value : String(value || "").split(/,|\band\b/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    const mapped = [...new Set(arr.map((x) => EQUIPMENT_OPTIONS.find((o) => o.toLowerCase() === x) || EQUIPMENT_OPTIONS.find((o) => x.includes(o.toLowerCase().split(" ")[0]) && o.toLowerCase().split(" ")[0].length > 3)).filter(Boolean))];
    return mapped.length ? { ok: true, value: mapped } : { ok: false };
  }
  if (field === "injury_history") {
    const t = String(value || "").replace(/\s+/g, " ").trim();
    return t && t.length <= 1000 ? { ok: true, value: t } : { ok: false };
  }
  return { ok: false };
}

export function planReviewOutcomes({ targets = [], verdicts = {}, notes = [], goals = [], athlete = {}, now = new Date(), extractorOk = true } = {}) {
  const stampNow = new Date(now).toISOString();
  const out = { noteOps: [], goalOps: [], athleteWrites: {}, newGoalText: null, lines: [] };
  if (!extractorOk) return out;                                    // no reading of the answers, no change at all
  const stamps = { ...(athlete.review_stamps || {}) };
  let stampsChanged = false;
  for (const t of targets) {
    if (!t || !t.asked) continue;                                   // never put to the athlete: no count
    const v = verdicts[t.rid] || null;
    const answered = !!t.covered;
    if (!answered) continue;                                        // the check-in ended before they replied: no count
    const verdict = v ? v.verdict : "unclear";
    if (t.type === "note" || t.type === "workaround") {
      const row = activeFacts(notes, now).find((r) => String(r.id) === String(t.ref));
      if (!row) continue;                                           // changed or gone since: leave it
      if (verdict === "keep") out.noteOps.push({ op: "keep", id: row.id });
      else if (verdict === "remove") out.noteOps.push({ op: "delete", id: row.id });
      else if (verdict === "edit" && v.content && v.content.trim()) {
        const check = validateFact({ content: v.content, kind: row.kind, expires_at: v.expires_at || row.expires_at, now });
        if (check.ok) out.noteOps.push({ op: "edit", id: row.id, content: check.content, expires_at: v.expires_at || undefined });
      } else if (verdict === "unclear") out.noteOps.push({ op: "unanswered", id: row.id });
    } else if (t.type === "goal") {
      const g = (goals || []).find((x) => String(x.id) === String(t.ref));
      if (!g) continue;
      const count = Number(g.ask_count) || 0;
      if (verdict === "keep") out.goalOps.push({ type: "stamp", id: g.id, data: { confirmed_at: stampNow, ask_count: 0 } });
      else if (verdict === "remove") out.goalOps.push({ type: "supersede", id: g.id, data: { superseded_at: stampNow } });
      else if (verdict === "edit" && v.content && v.content.trim() && !t.older) { out.newGoalText = v.content.trim(); }
      else if (verdict === "edit" && t.older) out.goalOps.push({ type: "stamp", id: g.id, data: { confirmed_at: stampNow, ask_count: 0 } });
      else if (verdict === "unclear") {
        if (t.older && count + 1 >= UNANSWERED_TO_REMOVE) out.goalOps.push({ type: "supersede", id: g.id, data: { superseded_at: stampNow } });
        else if (!t.older && count + 1 >= UNANSWERED_TO_REMOVE) out.goalOps.push({ type: "stamp", id: g.id, data: { confirmed_at: stampNow, ask_count: 0 } }); // never drop the only goal; stop asking
        else out.goalOps.push({ type: "stamp", id: g.id, data: { ask_count: count + 1 } });
      }
    } else if (t.type === "signup") {
      const f = t.ref;
      const cur = stamps[f] || {};
      const count = Number(cur.ask_count) || 0;
      if (verdict === "keep") { stamps[f] = { confirmed_at: stampNow, ask_count: 0 }; stampsChanged = true; }
      else if (verdict === "edit") {
        const val = validateSignupValue(f, v.value != null ? v.value : v.content);
        if (val.ok) { out.athleteWrites[f] = val.value; stamps[f] = { confirmed_at: stampNow, ask_count: 0 }; stampsChanged = true; }
      } else if (verdict === "unclear") {
        // a signup field is never removed: two silent asks and it is left alone
        stamps[f] = count + 1 >= UNANSWERED_TO_REMOVE ? { confirmed_at: stampNow, ask_count: 0 } : { ...cur, ask_count: count + 1 };
        stampsChanged = true;
      }
    }
  }
  if (stampsChanged) out.athleteWrites.review_stamps = stamps;
  return out;
}

// One-line facts for a note about to be written: a fresh insert counts as
// checked (the athlete just told us), in its section.
export const stampFresh = (section, now = new Date()) => ({ section, confirmed_at: new Date(now).toISOString(), ask_count: 0 });
