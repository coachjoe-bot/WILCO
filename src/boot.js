// ─── BOOT LAYER: BUILD FRESHNESS, WARM-REOPEN SNAPSHOT, OFFLINE QUEUE ────────
// Three separate concerns that all live one layer above the service worker, and
// all three are rules that can lose data or strand someone on a dead build — so
// they sit in their own module with a regression suite (scripts/test-boot.mjs)
// instead of inline in App.jsx.
//
//  1. BUILD FRESHNESS  — sw.js serves navigations from the cached shell, so a tab
//     can keep running a build whose hashed chunks no longer exist. Today that is
//     only caught reactively, after a chunk import fails (a real coach crashed on
//     it 2026-07-21). Comparing the assets THIS document references against the
//     deployed /asset-manifest.json detects it proactively.
//  2. WARM-REOPEN SNAPSHOT — the boot batch is 5 gateway round-trips before the
//     header, log and Proof tab have anything in them. The last session's answer
//     is a fine thing to paint immediately while the fresh one is in flight.
//  3. OFFLINE QUEUE — the SW makes an offline OPEN work; the app layer never knew
//     it was offline, so a send in a dead-zone gym just errored.
//
// Everything here is storage-or-pure: no React, no fetch, no DOM beyond an
// injected document, so all of it is testable in node.

// ── 1. BUILD FRESHNESS ───────────────────────────────────────────────────────

// Every /assets/ path THIS document is running. Two independent sources, unioned:
// the module's own URL (the entry chunk — the one thing that is definitionally
// part of the running build) and the document's script/preload/stylesheet tags.
// Either alone would be enough in practice; together they survive a bundler
// changing how the entry is referenced.
export function runningAssetPaths(doc, moduleUrl) {
  const out = new Set();
  const add = (u) => {
    if (!u) return;
    try {
      const p = new URL(u, "https://x.invalid").pathname;
      if (p.startsWith("/assets/")) out.add(p);
    } catch (_) { /* not a URL we can read — skip */ }
  };
  add(moduleUrl);
  try {
    const nodes = doc && doc.querySelectorAll
      ? doc.querySelectorAll('script[src], link[rel="modulepreload"][href], link[rel="stylesheet"][href]')
      : [];
    for (const n of nodes) add(n.getAttribute("src") || n.getAttribute("href"));
  } catch (_) { /* no DOM (tests/SSR) — the module URL alone still answers */ }
  return out;
}

// Is the running build gone from the deployed manifest?
//
// Deliberately conservative — every uncertain case answers "no update":
//   • no manifest / unparseable / empty asset list → a bad or missing manifest
//     must never nag every client on the current build into reloading
//   • no running assets identified (dev server, exotic bundling) → nothing to
//     compare, so nothing to claim
// Only a manifest that positively lists assets AND positively omits one of ours
// counts, because that is precisely the state where a lazy import 404s.
export function isStaleBuild(runningAssets, manifest) {
  const live = manifest && Array.isArray(manifest.assets) ? manifest.assets : null;
  if (!live || live.length === 0) return false;
  const running = runningAssets instanceof Set ? runningAssets : new Set(runningAssets || []);
  if (running.size === 0) return false;
  const liveSet = new Set(live);
  for (const p of running) if (!liveSet.has(p)) return true;
  return false;
}

// ── 2. WARM-REOPEN SNAPSHOT ──────────────────────────────────────────────────

export const SNAPSHOT_VERSION = 1;
export const snapshotKey = (athleteId) => `wilco_snapshot_v1_${athleteId}`;
// A snapshot older than this is thrown away rather than painted. Long enough that
// a week away still opens warm, short enough that nobody is shown a month-stale
// session count as if it were current.
export const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// Rows kept. The snapshot only has to fill the first paint — the header count, the
// week strip and the first screen of MY LOG — before the real 100-row read lands.
// 30 full rows is ~60KB, which stays clear of the localStorage ceiling even with a
// shared device holding several athletes' snapshots.
export const SNAPSHOT_ROWS = 30;

// What actually gets written. Pure so the shape is pinned by a test: an accidental
// widening here (say, keeping all 100 rows) is a quota error on a shared phone,
// and a quota error would take the WHOLE localStorage write path down with it.
export function buildSnapshot({ athlete, workoutHistory, goals, context, digest, at }) {
  return {
    v: SNAPSHOT_VERSION,
    at: at || Date.now(),
    athlete: athlete ? stripSnapshotAthlete(athlete) : null,
    workouts: (Array.isArray(workoutHistory) ? workoutHistory : []).slice(0, SNAPSHOT_ROWS),
    goals: (Array.isArray(goals) ? goals : []).slice(0, 10),
    context: typeof context === "string" ? context : null,
    digest: digest || null,
  };
}

// The PIN never goes in the snapshot. It lives in the auth blob, which has its own
// trust window and its own wipe-on-logout — a second copy under a second key with
// different lifetime rules is exactly how a credential outlives its session.
function stripSnapshotAthlete(a) {
  const { pin: _pin, ...rest } = a || {};
  return rest;
}

export function saveSnapshot(athleteId, data, store) {
  const ls = store || safeLocalStorage();
  if (!ls || !athleteId) return false;
  try {
    ls.setItem(snapshotKey(athleteId), JSON.stringify(buildSnapshot(data)));
    return true;
  } catch (_) {
    // Quota (or private mode). Drop OTHER athletes' snapshots and try once more —
    // a shared team phone is the realistic way to hit this, and the athlete using
    // the device right now is the one whose snapshot is worth keeping.
    try {
      pruneSnapshots(athleteId, ls);
      ls.setItem(snapshotKey(athleteId), JSON.stringify(buildSnapshot(data)));
      return true;
    } catch (_e) { return false; }
  }
}

export function loadSnapshot(athleteId, store, now) {
  const ls = store || safeLocalStorage();
  if (!ls || !athleteId) return null;
  try {
    const s = JSON.parse(ls.getItem(snapshotKey(athleteId)) || "null");
    if (!s || s.v !== SNAPSHOT_VERSION) return null;
    if ((now || Date.now()) - (s.at || 0) >= SNAPSHOT_MAX_AGE_MS) return null;
    return {
      at: s.at || 0,
      athlete: s.athlete || null,
      workouts: Array.isArray(s.workouts) ? s.workouts : [],
      goals: Array.isArray(s.goals) ? s.goals : [],
      context: typeof s.context === "string" ? s.context : null,
      digest: s.digest || null,
    };
  } catch (_) { return null; }
}

export function clearSnapshot(athleteId, store) {
  const ls = store || safeLocalStorage();
  try { if (ls) ls.removeItem(snapshotKey(athleteId)); } catch (_) {}
}

// Remove every snapshot except `keepId`'s (used on quota failure and on logout).
export function pruneSnapshots(keepId, store) {
  const ls = store || safeLocalStorage();
  if (!ls) return;
  try {
    const keep = keepId ? snapshotKey(keepId) : null;
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k && k.startsWith("wilco_snapshot_v1_") && k !== keep) ls.removeItem(k);
    }
  } catch (_) {}
}

// ── 2b. GREETING ─────────────────────────────────────────────────────────────
// Extracted from the boot effect so the snapshot path and the network path
// produce the BYTE-IDENTICAL greeting from the same inputs. That equality is the
// whole reason a warm reopen can paint a greeting instantly without risking a
// visible rewrite when the real data lands a second later.
export function buildGreeting({ name, isFree, hasLog, dAgo, summary }) {
  const s = summary || "";
  if (!hasLog || isFree) {
    return isFree && hasLog
      ? `What's up, ${name}. I'm starting fresh — Free tier doesn't store your history between sessions. What did you get after today?`
      : `Welcome to WILCO, ${name}. Tell me about your first workout -- what you did, how it felt, any questions.`;
  }
  if (dAgo >= 7) return `${name}. It's been ${dAgo} days since your last log. That's a week. What happened? We can't build anything on inconsistency. ${s} What did you get after today?`;
  if (dAgo >= 4) return `${name}. ${dAgo} days since your last log. It's not about workout 1 -- it's about workout 100. ${s} What did you do today?`;
  if (dAgo >= 2) return `Back at it, ${name}. ${s} What did you get after today?`;
  return s ? `${name}. ${s} What are you getting after today?` : `What's up, ${name}. What did you get after today?`;
}

// ── 2c. APP-OPEN "TODAY'S SESSION" OPENER ────────────────────────────────────
// Instead of a bare greeting, a returning athlete opens the app to today's actual
// session with the weights already resolved to numbers (the Quick Log draft engine
// does the % -> weight math; see QL_DRAFT_SYS in App.jsx). Pure helpers so the
// eligibility rule and the message shape are pinned by a test.

// Who gets the opener: a returning, PAID athlete who has a program on file. Free
// tier stores no program/history server-side, so it always keeps the plain
// greeting. A temp (travel/injury) program counts — that IS today's session.
export function openerEligibleFor(a) {
  return !!a
    && a.first_chat_complete === true
    && (a.tier || "free") !== "free"
    && !!(a.temp_program_text || a.program_text);
}

// Frame the resolved draft as a session to RUN, not a log to type. The draft's
// first line is the program day label ("Day 5 – Push B"); we weave that into the
// lead and show the exercises below it. A lapsed athlete still gets the nudge.
export function buildTodayOpener({ name, dAgo, draft }) {
  const d = String(draft || "").trim();
  if (!d) return "";
  const nl = d.indexOf("\n");
  const dayLabel = (nl >= 0 ? d.slice(0, nl) : d).trim();
  const body = (nl >= 0 ? d.slice(nl + 1) : "").trim();
  const label = dayLabel ? ` — ${dayLabel}` : "";
  const lead = (dAgo != null && dAgo >= 4)
    ? `${name}. ${dAgo} days since your last log — let's get back on it. Here's today${label}:`
    : `What's up, ${name}. Here's today${label}:`;
  return `${lead}\n\n${body || d}\n\nRun it top to bottom and log it here when you're done -- or tell me if you're switching anything up.`;
}

// ── 3. OFFLINE SEND QUEUE ────────────────────────────────────────────────────
// A message typed with no signal is kept, not lost. It is held ONLY here (never
// optimistically written to workouts) so a queued log can never become a phantom
// session — it replays through the normal send() path when connectivity returns,
// which is the only path that parses, dedupes and persists correctly.

export const outboxKey = (athleteId) => `wilco_outbox_${athleteId}`;
export const OUTBOX_MAX = 20;          // a runaway loop can't fill localStorage
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000; // a day-old "did 5x5 today" is no longer today

export function readOutbox(athleteId, { store, now } = {}) {
  const ls = store || safeLocalStorage();
  if (!ls || !athleteId) return [];
  try {
    const raw = JSON.parse(ls.getItem(outboxKey(athleteId)) || "[]");
    if (!Array.isArray(raw)) return [];
    const t = now || Date.now();
    return raw
      .filter((m) => m && typeof m.text === "string" && m.text.trim() && t - (m.at || 0) < OUTBOX_MAX_AGE_MS)
      .map((m) => ({ text: m.text, at: m.at || 0, pure: !!m.pure, note: typeof m.note === "string" ? m.note : null }))
      .slice(-OUTBOX_MAX);
  } catch (_) { return []; }
}

export function writeOutbox(athleteId, items, { store } = {}) {
  const ls = store || safeLocalStorage();
  if (!ls || !athleteId) return;
  try {
    const clean = (Array.isArray(items) ? items : []).slice(-OUTBOX_MAX);
    if (clean.length === 0) ls.removeItem(outboxKey(athleteId));
    else ls.setItem(outboxKey(athleteId), JSON.stringify(clean));
  } catch (_) {}
}

// Append, ignoring an exact duplicate of the message already at the tail — a
// double-tap on SEND with no signal must not queue the workout twice.
//
// `pure` carries the Quick Log "this is a workout log, never a program" flag
// across the offline gap. Without it, a draft queued in a dead-zone gym would
// replay hours later as an unflagged message and could be classified as a
// program — silently overwriting program_text with a workout log.
// `note` is the Quick Log TODAY'S FOCUS text, which gets stamped onto the workout
// row — it was generated by a paid Sonnet call and would otherwise evaporate
// across the offline gap. Capped so a runaway note can't bloat the queue.
export function queueOutbox(athleteId, text, { store, now, pure, note } = {}) {
  const t = String(text || "").trim();
  if (!t) return readOutbox(athleteId, { store, now });
  const cur = readOutbox(athleteId, { store, now });
  if (cur.length && cur[cur.length - 1].text === t) return cur;
  const next = [...cur, { text: t, at: now || Date.now(), pure: !!pure, note: note ? String(note).slice(0, 1200) : null }];
  writeOutbox(athleteId, next, { store });
  return next.slice(-OUTBOX_MAX);
}

// Pop the oldest queued message (the flush drains one at a time so each replay
// goes through send()'s normal in-flight guards).
export function shiftOutbox(athleteId, { store, now } = {}) {
  const cur = readOutbox(athleteId, { store, now });
  if (!cur.length) return { item: null, rest: [] };
  const [item, ...rest] = cur;
  writeOutbox(athleteId, rest, { store });
  return { item, rest };
}

export function clearOutbox(athleteId, { store } = {}) {
  const ls = store || safeLocalStorage();
  try { if (ls) ls.removeItem(outboxKey(athleteId)); } catch (_) {}
}

// ── shared ───────────────────────────────────────────────────────────────────
function safeLocalStorage() {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (_) { return null; }
}
