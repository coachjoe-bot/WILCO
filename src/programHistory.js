// ─── PROGRAM HISTORY — block snapshots of program_text ────────────────────────
// Program Builder Phase B (docs/program-builder-build-handoff.md): every
// save-to-program records what the athlete was actually running, so the Builder's
// block hand-off question ("how did the last block go?") has real data at launch.
//
// One row in program_history ≈ one training BLOCK, not one save. The distinction
// is made here, not at the call sites: a save whose text is mostly the same as
// the current block (a weight bump from PR propagation, a check-in tweak, a
// one-lift swap) UPDATES the open block's text in place, keeping its applied_at;
// a save that mostly rewrites it (or replaces it outright) CLOSES the open block
// (completed_at) and opens a new row. Callers that KNOW they're a wholesale
// replacement pass forceNewBlock so a coincidentally-similar new program still
// gets its own block. A block that is already CLOSED is never reopened or
// evolved — any save after a close starts a new block, however similar the text
// (the athlete deliberately ended that chapter via "Start next block").
//
// When a block closes, a RECAP is generated best-effort: the logs inside the
// block's date range + the athlete's goal are condensed into a few sentences
// (what was trained, what moved, goal status) stored in block_recap — the
// "proof feed over a whole block" the Past Blocks tab shows, and the context
// the Builder hands the next interview.
//
// Like changeRequest.js, this module takes the App.jsx data/AI helpers as
// arguments instead of importing them (App.jsx imports this file — a static
// import back would be a cycle). React-free; block-decision logic unit tested by
// scripts/test-program-history.mjs.
import { lineDiff } from "./programDiff.js";
import { currentPosition } from "./programPosition.js";
import { parseBlockInfo, stripBlockInfo } from "./programContract.js";

// Fraction of the COMBINED line count that changed between two program texts.
// 0 = identical, 1 = nothing in common. Exported for the test suite.
export function changedRatio(oldText, newText) {
  const diff = lineDiff(oldText, newText);
  const meaningful = diff.filter((d) => d.text.trim() !== "");
  if (meaningful.length === 0) return 0;
  const changed = meaningful.filter((d) => d.type !== "same").length;
  return changed / meaningful.length;
}

// Above this fraction of changed lines, a save is a NEW block rather than an
// evolution of the open one. Half the program rewritten = you changed programs.
export const NEW_BLOCK_RATIO = 0.5;

// The block's IDENTITY as its own text declares it: the caller's name, else a
// contract program's Goal line, else the first real line. Used both to name new
// rows and to recognize that a big mid-block edit is still the SAME block: a
// check-in that rewrites half the sheet under an unchanged "BLOCK 1 — ROAD TO
// 315" header is an evolution, not a new chapter (Will 08-28: the ratio alone
// split his running block into a current AND a past card).
export function deriveBlockName(text, blockName = null) {
  const t = String(text || "");
  const info = parseBlockInfo(t);
  return (blockName || (info.found && info.goal) || stripBlockInfo(t).split("\n").find((l) => l.trim()) || "").trim().slice(0, 80);
}

const SUMMARY_SYS =
  "You summarize a strength training program in ONE line (max 90 characters) for a history list: " +
  "the main focus and split, e.g. \"4-day upper/lower — squat & bench strength, 5s progression\". " +
  "Plain text, no quotes, no preamble, no second line.";

const RECAP_SYS =
  "You are Coach Joe writing the closing recap of a COMPLETED training block for an athlete's " +
  "block history. You get the program that was planned, the training actually logged during the " +
  "block, the goal that was attached to it, and a BLOCK FACTS line computed by the app. Write ONE " +
  "tight plain-text paragraph — 3 to 6 sentences, hard limit, and always FINISH your final " +
  "sentence: what the block focused on, what actually got trained (be honest about adherence — " +
  "logged sessions vs the plan), what visibly moved (weights, reps, PRs), and where the goal " +
  "stands — HIT, CLOSE, or STILL CHASING — so the next block can pick it up or retire it. " +
  "NUMBERS: the BLOCK FACTS line is computed by the app and is always right — use its dates, " +
  "session count, and block length over anything you'd derive yourself. Every logged load carries " +
  "its unit (kg or lbs) — keep each number in the unit it carries and NEVER quote a load without " +
  "its unit; the program text may mix units, so restate any number you take from it with the unit " +
  "written there. Joe's voice: direct, warm, no hype, no markdown, no headers. If there are no " +
  "logs, say the block has no logged training and leave it at that — never invent results.";

// T64 Fix 3b (Will 09-28): the full recap above is written for the AI (the
// Builder's block-handoff context) and Will found it too long to read on the
// Past Blocks card. This condenses it into ONE short, plain, second-person
// line for the athlete — the full text stays intact behind a "More" tap in
// the render, and is still what the Builder reads. Runs AFTER the full recap
// so it has real prose to condense rather than re-deriving from raw logs.
const RECAP_SHORT_SYS =
  "Condense this closing training-block recap into ONE short line for the athlete reading their own " +
  "history, 40 words or fewer, hard limit. Second person (\"you\"), plain facts and numbers only: what " +
  "was trained, what moved, where the goal stands. No coach-voice flourishes, no filler, no headers, " +
  "no quotes around the output. Every load keeps its unit (kg or lbs) exactly as written in the recap.";

const capWords40 = (s) => {
  const words = String(s || "").trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  return words.length <= 40 ? words.join(" ") : words.slice(0, 40).join(" ");
};

// A short, athlete-facing line for a Past Blocks card: the stored short recap
// when one exists, else the first two sentences of the full recap (every row
// saved before this shipped, or a short-generation that failed), else nothing.
// Pure and exported so the render and the tests share one funnel.
export function recapShortFallback(block) {
  const { block_recap_short, block_recap } = block || {};
  const short = String(block_recap_short || "").trim();
  if (short) return short;
  const full = String(block_recap || "").trim();
  if (!full) return "";
  const sentences = full.match(/[^.!?]+[.!?]+/g) || [full];
  return sentences.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
}

// Compact one-line-per-session digest of logged training inside a date range.
// Pure formatting (exported for tests); the AI never sees raw rows.
export function digestWorkouts(rows) {
  const lines = [];
  for (const w of Array.isArray(rows) ? rows : []) {
    const d = String(w.created_at || "").slice(0, 10);
    const exs = (w.parsed_data && Array.isArray(w.parsed_data.exercises)) ? w.parsed_data.exercises : [];
    const parts = exs.slice(0, 8).map((e) => {
      if (!e || !e.name) return null;
      const sr = e.sets && e.reps ? ` ${e.sets}x${e.reps}` : "";
      const wt = e.weight ? ` @${e.weight}${e.unit === "kg" ? "kg" : "lbs"}` : "";
      return `${e.name}${sr}${wt}`;
    }).filter(Boolean);
    if (parts.length) lines.push(`${d}: ${parts.join(", ")}`);
  }
  const s = lines.join("\n");
  // Over the cap, keep the block's START and END — progress is first-vs-last
  // numbers; the middle is the least informative part of a long block.
  return s.length <= 3200 ? s : `${s.slice(0, 1600)}\n…\n${s.slice(-1600)}`;
}

// Close an open block row: stamp completed_at, then best-effort generate the
// recap from the logs that fell inside the block. The stamp must land even when
// the recap fails (recap is AI + extra reads; the close is the source of truth).
// completedAtOverride: "retire" ends a phase at the LAST WORKOUT logged under
// it, not at the moment the button was tapped.
async function closeBlock(athleteId, row, deps, completedAtOverride = null) {
  const { sbRead, sbUpdateWhere, askClaude } = deps;
  const completedAt = (completedAtOverride && !Number.isNaN(Date.parse(completedAtOverride)))
    ? new Date(completedAtOverride).toISOString()
    : new Date().toISOString();
  await sbUpdateWhere("program_history", `?id=eq.${row.id}`, { completed_at: completedAt });
  try {
    const from = row.applied_at ? `&created_at=gte.${encodeURIComponent(row.applied_at)}` : "";
    const [logs, goals] = await Promise.all([
      sbRead("workouts", `?athlete_id=eq.${athleteId}${from}&created_at=lte.${encodeURIComponent(completedAt)}&order=created_at.asc&limit=80&select=created_at,parsed_data`).catch(() => []),
      sbRead("athlete_goals", `?athlete_id=eq.${athleteId}&order=created_at.desc&limit=1`).catch(() => []),
    ]);
    const digest = digestWorkouts(logs);
    const goal = (Array.isArray(goals) && goals[0] && (goals[0].goal_text || goals[0].text)) || "";
    // T55: hand the model code-computed facts instead of letting it derive dates,
    // counts, or block length from mixed text (the source of the wrong past-block
    // summaries). Same doctrine as the coach-brain fixes: compute in code, inject.
    const ranDays = row.applied_at ? Math.max(1, Math.round((Date.parse(completedAt) - Date.parse(row.applied_at)) / 86400000)) : null;
    let declaredWeeks = null;
    try {
      const pos = currentPosition({ programText: String(row.program_text || ""), startedOn: row.applied_at, sessions: [] });
      if (pos.weekKnown && pos.weekCount > 0) declaredWeeks = pos.weekCount;
    } catch (_) {}
    let gate = null;
    try { gate = parseBlockInfo(String(row.program_text || "")).gate || null; } catch (_) {}
    const factBits = [
      row.applied_at ? `ran ${String(row.applied_at).slice(0, 10)} → ${completedAt.slice(0, 10)}${ranDays ? ` (${ranDays} days)` : ""}` : null,
      `${(Array.isArray(logs) ? logs.length : 0)} workout rows logged in the block`,
      declaredWeeks ? `the program itself is a ${declaredWeeks}-week block` : null,
      gate ? `the block's agreed GATE was: ${gate} — judge it plainly in the recap (hit or missed, from the logs)` : null,
    ].filter(Boolean).join(" · ");
    const user =
      `BLOCK FACTS (computed by the app — authoritative): ${factBits}\n\n` +
      `PROGRAM THE BLOCK RAN:\n${String(row.program_text || "").slice(0, 2500)}\n\n` +
      `GOAL ATTACHED TO THIS BLOCK: ${goal || "(none on file)"}\n\n` +
      `TRAINING LOGGED DURING THE BLOCK:\n${digest || "(no logged sessions)"}`;
    const recap = await askClaude(RECAP_SYS, user, 600, [], "claude-sonnet-5", "program_summary");
    const text = (recap || "").trim();
    if (text) {
      await sbUpdateWhere("program_history", `?id=eq.${row.id}`, { block_recap: text.slice(0, 1500) });
      // T64 Fix 3b: the short athlete-facing line is its OWN best-effort write,
      // deliberately separate from the one above — block_recap_short is a new
      // nullable column (20260928_program_history_block_recap_short.sql) that
      // this session does NOT apply to prod (SHIP DARK FIRST in the handoff),
      // so this call can fail with "unknown column" until it's applied without
      // ever costing the real recap write. The render falls back to the first
      // two sentences of the full recap until this lands (recapShortFallback).
      try {
        const short = capWords40(((await askClaude(RECAP_SHORT_SYS, text, 120, [], "claude-haiku-4-5", "program_summary")) || "").trim());
        if (short) await sbUpdateWhere("program_history", `?id=eq.${row.id}`, { block_recap_short: short });
      } catch (_) {}
    }
  } catch (e) { console.error("[history] block recap failed:", e?.message || e); }
}

// Live status paragraph for the OPEN block — the current-phase card's answer to
// the recap past blocks get (Will 08-28: "keep the current block up to date on
// what's been done, brief, and speak as though it's ongoing, not incomplete").
// Written into the same block_recap column; closeBlock overwrites it with the
// final past-tense recap when the block actually ends.
const ONGOING_RECAP_SYS =
  "You are Coach Joe writing the LIVE status paragraph for a training block that is STILL RUNNING, " +
  "shown on the athlete's current-phase card. You get the program, the training logged so far, the " +
  "goal, and a BLOCK FACTS line computed by the app. Write ONE tight plain-text paragraph, 2 to 4 " +
  "sentences, hard limit, and always FINISH your final sentence: what the block is focused on, what " +
  "has actually been trained so far, and what is moving. Present tense, ongoing voice ('so far', " +
  "'is building'): the block is NOT over, so never sum it up like a finished chapter, never judge " +
  "the goal as hit or missed, never speak of what the block 'was'. NUMBERS: the BLOCK FACTS line is " +
  "computed by the app and is always right — use its dates and session count over anything you'd " +
  "derive yourself. Every logged load carries its unit (kg or lbs) — keep each number in the unit " +
  "it carries and NEVER quote a load without its unit. Joe's voice: direct, warm, no hype, no " +
  "markdown, no headers. Only a session or two logged means one or two sentences, never padding.";

// Refresh the open block's live recap from the logs inside its window. Returns
// the new recap text, or null when there is nothing to write (no open block, or
// no logged sessions yet — an empty block keeps an empty recap, never filler).
// Callers own the throttling; this always generates when called.
export async function refreshOpenBlockRecap({ athleteId }, deps) {
  const { sbRead, sbUpdateWhere, askClaude } = deps;
  const rows = await sbRead(
    "program_history",
    `?athlete_id=eq.${athleteId}&order=applied_at.desc&limit=1&select=id,program_text,applied_at,completed_at,ends_at`
  );
  const row = (Array.isArray(rows) && rows[0]) || null;
  if (!row || row.completed_at) return null;
  const from = row.applied_at ? `&created_at=gte.${encodeURIComponent(row.applied_at)}` : "";
  const [logs, goals] = await Promise.all([
    sbRead("workouts", `?athlete_id=eq.${athleteId}${from}&order=created_at.asc&limit=80&select=created_at,parsed_data`).catch(() => []),
    sbRead("athlete_goals", `?athlete_id=eq.${athleteId}&order=created_at.desc&limit=1`).catch(() => []),
  ]);
  if (!Array.isArray(logs) || logs.length === 0) return null;
  const digest = digestWorkouts(logs);
  const goal = (Array.isArray(goals) && goals[0] && (goals[0].goal_text || goals[0].text)) || "";
  const daysIn = row.applied_at ? Math.max(1, Math.round((Date.now() - Date.parse(row.applied_at)) / 86400000)) : null;
  let declaredWeeks = null;
  try {
    const pos = currentPosition({ programText: String(row.program_text || ""), startedOn: row.applied_at, sessions: [] });
    if (pos.weekKnown && pos.weekCount > 0) declaredWeeks = pos.weekCount;
  } catch (_) {}
  const factBits = [
    row.applied_at ? `started ${String(row.applied_at).slice(0, 10)}${daysIn ? ` (${daysIn} days in)` : ""}` : null,
    `${logs.length} workout rows logged so far`,
    declaredWeeks ? `the program itself is a ${declaredWeeks}-week block` : null,
    row.ends_at ? `planned to wrap ${String(row.ends_at).slice(0, 10)}` : null,
  ].filter(Boolean).join(" · ");
  const user =
    `BLOCK FACTS (computed by the app — authoritative): ${factBits}\n\n` +
    `PROGRAM THE BLOCK IS RUNNING:\n${String(row.program_text || "").slice(0, 2500)}\n\n` +
    `GOAL ATTACHED TO THIS BLOCK: ${goal || "(none on file)"}\n\n` +
    `TRAINING LOGGED SO FAR:\n${digest}`;
  const recap = ((await askClaude(ONGOING_RECAP_SYS, user, 400, [], "claude-sonnet-5", "program_summary")) || "").trim().slice(0, 1500);
  if (!recap) return null;
  await sbUpdateWhere("program_history", `?id=eq.${row.id}`, { block_recap: recap });
  return recap;
}

// Fire-and-forget from every program_text save path (never await it on the save's
// critical path, never let it throw into the caller). deps = {sbRead, sbInsert,
// sbUpdateWhere, askClaude} from App.jsx.
export async function snapshotProgramHistory({ athleteId, text, source, forceNewBlock = false, startsAt = null, endsAt = null, blockName = null }, deps) {
  const { sbRead, sbInsert, askClaude } = deps;
  const t = (text || "").trim();
  const rows = await sbRead(
    "program_history",
    `?athlete_id=eq.${athleteId}&order=applied_at.desc&limit=1&select=id,program_text,completed_at,applied_at`
  );
  const latest = (Array.isArray(rows) && rows[0]) || null;

  // Program cleared → the block ended; close it (with recap), snapshot nothing.
  if (!t) {
    if (latest && !latest.completed_at) await closeBlock(athleteId, latest, deps);
    return;
  }

  if (latest && !latest.completed_at && (latest.program_text || "").trim() === t) return; // no-op save

  // A closed latest block never evolves in place — a save after "Start next
  // block" (or after the program was cleared) is a new chapter by definition.
  // An OPEN block whose text still declares the same identity (same Goal line /
  // header) evolves in place no matter how much changed: mid-block edits never
  // cut history. Only forceNewBlock (a caller that KNOWS it's a replacement)
  // overrides that.
  const sameIdentity = (() => {
    if (!latest || latest.completed_at) return false;
    const oldName = deriveBlockName(latest.program_text || "");
    const newName = deriveBlockName(t, blockName);
    return !!oldName && !!newName && oldName.toLowerCase() === newName.toLowerCase();
  })();
  const isNewBlock = forceNewBlock || !latest || !!latest.completed_at
    || (!sameIdentity && changedRatio(latest.program_text || "", t) >= NEW_BLOCK_RATIO);
  if (!isNewBlock) {
    // Same block, evolved text. applied_at and source stay those of the block's
    // first save; per-tweak provenance already lives in program_modifications.
    await deps.sbUpdateWhere("program_history", `?id=eq.${latest.id}`, { program_text: t });
    return;
  }

  if (latest && !latest.completed_at) await closeBlock(athleteId, latest, deps);

  // Haiku one-liner BEFORE the insert so the row lands complete in one write
  // (the gateway's insert doesn't return the new id). Best-effort: a summary
  // failure must never cost the snapshot itself.
  let summary = null;
  try {
    const line = await askClaude(SUMMARY_SYS, t.slice(0, 4000), 80, [], "claude-haiku-4-5", "program_summary");
    summary = (line || "").trim().split("\n")[0].slice(0, 120) || null;
  } catch (_) {}

  // applied_at doubles as the block's START (programPosition.js reads it as the
  // preferred week-1 anchor), so a Builder timeline start lands here. ends_at is
  // the PLANNED end — the date the whole boundary system keys off.
  const row = {
    athlete_id: athleteId,
    program_text: t,
    source,
    block_summary: summary,
    // Explicit rather than relying on the DB default: the demo's mock store has
    // no column defaults, and ordering/date-ranges key off this everywhere.
    applied_at: startsAt || new Date().toISOString(),
  };
  if (endsAt) row.ends_at = endsAt;
  // Phase name: caller-provided ("what are we calling it"), else a contract
  // program names itself from its own Goal line ("Bench 245 by Oct 10") — the
  // first body line can be Joe's prose intro, and half a sentence about ratios
  // is not a block name (T57 s5 live find) — else the program's first REAL line
  // through stripBlockInfo, never the literal "=== BLOCK INFO ===" banner.
  const name = deriveBlockName(t, blockName);
  if (name) row.block_name = name;
  await sbInsert("program_history", row);
}

// "Start next block": the CURRENT block is done without the program text
// changing — e.g. a 12-week program with two internal blocks, moving from block
// 1 to block 2. Closes the open row (recap and all) and opens a fresh row on
// the same text, so each block gets its own date range, logs window, and recap.
// Returns true when a transition happened. Two callers, two sources:
// - "next_block": the explicit Past Blocks button (user declared the boundary)
// - "goal_change": the check-in surfaced a NEW goal — the strongest organic
//   boundary signal there is (a shifted goal means a shifted chapter), and it
//   costs the user nothing: no one has to know what a "block" is.
export async function startNextBlock({ athleteId, programText, source = "next_block" }, deps) {
  const { sbRead, sbInsert } = deps;
  const rows = await sbRead(
    "program_history",
    `?athlete_id=eq.${athleteId}&order=applied_at.desc&limit=1&select=id,program_text,block_summary,completed_at,applied_at`
  );
  const latest = (Array.isArray(rows) && rows[0]) || null;
  if (!latest || latest.completed_at) return false;
  await closeBlock(athleteId, latest, deps);
  await sbInsert("program_history", {
    athlete_id: athleteId,
    program_text: (programText || latest.program_text || "").trim() || latest.program_text,
    source,
    block_summary: latest.block_summary || null,
    applied_at: new Date().toISOString(),
  });
  return true;
}

// Close the open block WITHOUT opening a successor — the athlete said "it's
// done" at the end-of-program prompt. The next program save opens the next
// chapter (the closed-latest rule guarantees it's a fresh row).
export async function closeCurrentBlock({ athleteId, completedAt = null }, deps) {
  const rows = await deps.sbRead(
    "program_history",
    `?athlete_id=eq.${athleteId}&order=applied_at.desc&limit=1&select=id,program_text,block_summary,completed_at,applied_at`
  );
  const latest = (Array.isArray(rows) && rows[0]) || null;
  if (!latest || latest.completed_at) return false;
  await closeBlock(athleteId, latest, deps, completedAt);
  return true;
}

// Stamp (or move) the open block's planned end — from the Builder timeline,
// a typed chat confirmation, or an "extend N weeks" tap.
export async function setBlockEnd({ athleteId, endsAt }, deps) {
  if (!endsAt || Number.isNaN(Date.parse(endsAt))) return false;
  const rows = await deps.sbRead(
    "program_history",
    `?athlete_id=eq.${athleteId}&order=applied_at.desc&limit=1&select=id,completed_at`
  );
  const latest = (Array.isArray(rows) && rows[0]) || null;
  if (!latest || latest.completed_at) return false;
  await deps.sbUpdateWhere("program_history", `?id=eq.${latest.id}`, { ends_at: new Date(endsAt).toISOString() });
  return true;
}

// Timeline cell value ("YYYY-MM-DD to YYYY-MM-DD") → {start, end} (either may
// be null). Tolerant: grabs the ISO dates in order; a single date is read as
// the END — the part the boundary system actually needs.
export function parseTimeline(value) {
  const dates = String(value || "").match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (dates.length === 0) return { start: null, end: null };
  if (dates.length === 1) return { start: null, end: dates[0] };
  return { start: dates[0], end: dates[dates.length - 1] };
}

// A bare YYYY-MM-DD from parseTimeline → a full timestamp the DB can hold.
// Noon UTC so the calendar day survives every timezone's rendering.
export const dateToIso = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : null);

// Pure eligibility for the end-of-program chat prompt. 'ending' = inside the
// heads-up window before the planned end; 'ended' = the date has passed and the
// block is still open. null = nothing to say.
export function blockPromptState({ endsAt, now = null, soonDays = 7 } = {}) {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return null;
  const t = now ? Date.parse(now) : Date.now();
  if (t >= end) return "ended";
  if (end - t <= soonDays * 86400000) return "ending";
  return null;
}
