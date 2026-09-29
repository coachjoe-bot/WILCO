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
import { exerciseLoadUnit } from "./units.js";
import { currentPosition, parseBlockSpan, programTextIdentity } from "./programPosition.js";
import { parseBlockInfo, stripBlockInfo } from "./programContract.js";
import { gateText } from "./replyGate.js";
import { JOE_IDENTITY, VOICE_ATHLETE } from "./ai/voice.js";

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
  "the main focus and split, e.g. \"4-day upper/lower, squat & bench strength, 5s progression\". " +
  "Plain text, no quotes, no preamble, no second line, no em dashes, no profanity.";

const RECAP_SYS =
  `${JOE_IDENTITY} ` +
  "You are writing the closing recap of a COMPLETED training block for an athlete's " +
  "block history. You get the program that was planned, the training actually logged during the " +
  "block, the goal that was attached to it, and a BLOCK FACTS line computed by the app. Write ONE " +
  "tight plain-text paragraph, 3 to 6 sentences, hard limit, and always FINISH your final " +
  "sentence: what the block focused on, what actually got trained (be honest about adherence: " +
  "logged sessions vs the plan), what visibly moved (weights, reps, PRs), and where the goal " +
  "stands (HIT, CLOSE, or STILL CHASING) so the next block can pick it up or retire it. " +
  "NUMBERS: the BLOCK FACTS line is computed by the app and is always right: use its dates, " +
  "session count, and block length over anything you'd derive yourself. Every logged load carries " +
  "its unit (kg or lbs): keep each number in the unit it carries and NEVER quote a load without " +
  "its unit; the program text may mix units, so restate any number you take from it with the unit " +
  "written there. No headers. If there are no logs, say the block has no logged training and " +
  "leave it at that, never invent results.\nVOICE (the app's one voice source):\n" + VOICE_ATHLETE;

// T64 Fix 3b (Will 09-28): the full recap above is written for the AI (the
// Builder's block-handoff context) and Will found it too long to read on the
// Past Blocks card. This condenses it into ONE short, plain, second-person
// line for the athlete — the full text stays intact behind a "More" tap in
// the render, and is still what the Builder reads. Runs AFTER the full recap
// so it has real prose to condense rather than re-deriving from raw logs.
const RECAP_SHORT_SYS =
  "Condense this closing training-block recap into ONE short line for the athlete reading their own " +
  "history, 40 words or fewer, hard limit. Second person (\"you\"), plain facts and numbers only: what " +
  "was trained, what moved, where the goal stands. No headers, no quotes around the output. Every " +
  "load keeps its unit (kg or lbs) exactly as written in the recap.\nVOICE (the app's one voice source):\n" + VOICE_ATHLETE;

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
      const wt = e.weight ? ` @${e.weight}${exerciseLoadUnit(e)}` : "";
      return `${e.name}${sr}${wt}`;
    }).filter(Boolean);
    if (parts.length) lines.push(`${d}: ${parts.join(", ")}`);
  }
  const s = lines.join("\n");
  // Over the cap, keep the block's START and END — progress is first-vs-last
  // numbers; the middle is the least informative part of a long block.
  return s.length <= 3200 ? s : `${s.slice(0, 1600)}\n…\n${s.slice(-1600)}`;
}

// The recap itself: a Sonnet call plus two reads, a second or several. Split out
// of closeBlock (T64 Fix 7a) so the close's ROW WRITES — which is what the next
// chat turn's position read actually depends on — never wait on it. Fire-and-
// forget from closeBlock; never awaited on any save's critical path.
async function generateBlockRecap(athleteId, row, completedAt, deps) {
  const { sbRead, sbUpdateWhere, askClaude } = deps;
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
      gate ? `the block's agreed GATE was: ${gate}; judge it plainly in the recap (hit or missed, from the logs)` : null,
    ].filter(Boolean).join(" · ");
    const user =
      `BLOCK FACTS (computed by the app — authoritative): ${factBits}\n\n` +
      `PROGRAM THE BLOCK RAN:\n${String(row.program_text || "").slice(0, 2500)}\n\n` +
      `GOAL ATTACHED TO THIS BLOCK: ${goal || "(none on file)"}\n\n` +
      `TRAINING LOGGED DURING THE BLOCK:\n${digest || "(no logged sessions)"}`;
    const recap = await askClaude(RECAP_SYS, user, 600, [], "claude-sonnet-5", "program_summary");
    const text = gateText("recap", (recap || "").trim());   // T64 S4: one output gate
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
        const short = capWords40(gateText("recap", ((await askClaude(RECAP_SHORT_SYS, text, 120, [], "claude-haiku-4-5", "program_summary")) || "").trim()));
        if (short) await sbUpdateWhere("program_history", `?id=eq.${row.id}`, { block_recap_short: short });
      } catch (_) {}
    }
  } catch (e) { console.error("[history] block recap failed:", e?.message || e); }
}

// Close an open block row: stamp completed_at (the ONLY part anything downstream
// waits on), then kick off the recap in the background. completedAtOverride:
// "retire" ends a phase at the LAST WORKOUT logged under it, not at the moment
// the button was tapped.
//
// T64 Fix 7a: this used to AWAIT the whole recap (a Sonnet call plus two reads)
// before returning, which meant a chat message sent seconds after a program save
// could race a still-in-flight close — the very next block's row wasn't inserted
// yet, so "what's today" read the OLD block's start date. The recap is real work
// but nothing except the athlete's Past Blocks tab needs it fast; the position
// system only needs the completed_at stamp and the new row's applied_at, both of
// which are now on the critical path and nothing else is.
async function closeBlock(athleteId, row, deps, completedAtOverride = null) {
  const { sbUpdateWhere } = deps;
  const completedAt = (completedAtOverride && !Number.isNaN(Date.parse(completedAtOverride)))
    ? new Date(completedAtOverride).toISOString()
    : new Date().toISOString();
  await sbUpdateWhere("program_history", `?id=eq.${row.id}`, { completed_at: completedAt });
  generateBlockRecap(athleteId, row, completedAt, deps).catch((e) => console.error("[history] block recap failed:", e?.message || e));
  return completedAt;
}

// Live status paragraph for the OPEN block — the current-phase card's answer to
// the recap past blocks get (Will 08-28: "keep the current block up to date on
// what's been done, brief, and speak as though it's ongoing, not incomplete").
// Written into the same block_recap column; closeBlock overwrites it with the
// final past-tense recap when the block actually ends.
const ONGOING_RECAP_SYS =
  `${JOE_IDENTITY} ` +
  "You are writing the LIVE status paragraph for a training block that is STILL RUNNING, " +
  "shown on the athlete's current-phase card. You get the program, the training logged so far, the " +
  "goal, and a BLOCK FACTS line computed by the app. Write ONE tight plain-text paragraph, 2 to 4 " +
  "sentences, hard limit, and always FINISH your final sentence: what the block is focused on, what " +
  "has actually been trained so far, and what is moving. Present tense, ongoing voice ('so far', " +
  "'is building'): the block is NOT over, so never sum it up like a finished chapter, never judge " +
  "the goal as hit or missed, never speak of what the block 'was'. NUMBERS: the BLOCK FACTS line is " +
  "computed by the app and is always right: use its dates and session count over anything you'd " +
  "derive yourself. Every logged load carries its unit (kg or lbs): keep each number in the unit " +
  "it carries and NEVER quote a load without its unit. No headers. Only a session or two logged " +
  "means one or two sentences, never padding.\nVOICE (the app's one voice source):\n" + VOICE_ATHLETE;

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
  const recap = gateText("recap", ((await askClaude(ONGOING_RECAP_SYS, user, 400, [], "claude-sonnet-5", "program_summary")) || "").trim()).slice(0, 1500);
  if (!recap) return null;
  await sbUpdateWhere("program_history", `?id=eq.${row.id}`, { block_recap: recap });
  return recap;
}

// Fire-and-forget from every program_text save path (never await it on the save's
// critical path, never let it throw into the caller). deps = {sbRead, sbInsert,
// sbUpdateWhere, askClaude, onBlockStart} from App.jsx. onBlockStart(text,
// startedOn), when given, fires the MOMENT this function knows the current
// block's start — before the Haiku summary call or the row insert — so the
// caller can prime its own chat-context cache synchronously instead of racing a
// DB read against this still-in-flight write (T64 Fix 7a).
export async function snapshotProgramHistory({ athleteId, text, source, forceNewBlock = false, startsAt = null, endsAt = null, blockName = null }, deps) {
  const { sbRead, sbInsert, askClaude, onBlockStart } = deps;
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
    // The start hasn't moved, but prime anyway — a chat turn racing THIS save
    // must see the (unchanged) start under the NEW text's identity, not fall
    // through to a cache miss that re-reads a row this same write is touching.
    if (onBlockStart) { try { onBlockStart(t, latest.applied_at || null); } catch (_) {} }
    await deps.sbUpdateWhere("program_history", `?id=eq.${latest.id}`, { program_text: t });
    return;
  }

  if (latest && !latest.completed_at) await closeBlock(athleteId, latest, deps);

  // applied_at doubles as the block's START (programPosition.js reads it as the
  // preferred week-1 anchor), so a Builder timeline start lands here. ends_at is
  // the PLANNED end — the date the whole boundary system keys off. Resolved and
  // handed to onBlockStart BEFORE the summary/insert below — those are still
  // real network+AI latency that a fast-following chat turn must never wait on.
  const appliedAt = startsAt || new Date().toISOString();
  if (onBlockStart) { try { onBlockStart(t, appliedAt); } catch (_) {} }

  // Haiku one-liner BEFORE the insert so the row lands complete in one write
  // (the gateway's insert doesn't return the new id). Best-effort: a summary
  // failure must never cost the snapshot itself.
  let summary = null;
  try {
    const line = await askClaude(SUMMARY_SYS, t.slice(0, 4000), 80, [], "claude-haiku-4-5", "program_summary");
    summary = gateText("recap", (line || "").trim().split("\n")[0]).slice(0, 120) || null;
  } catch (_) {}

  const row = {
    athlete_id: athleteId,
    program_text: t,
    source,
    block_summary: summary,
    // Explicit rather than relying on the DB default: the demo's mock store has
    // no column defaults, and ordering/date-ranges key off this everywhere.
    applied_at: appliedAt,
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
  const { sbRead, sbInsert, onBlockStart } = deps;
  const rows = await sbRead(
    "program_history",
    `?athlete_id=eq.${athleteId}&order=applied_at.desc&limit=1&select=id,program_text,block_summary,completed_at,applied_at`
  );
  const latest = (Array.isArray(rows) && rows[0]) || null;
  if (!latest || latest.completed_at) return false;
  await closeBlock(athleteId, latest, deps);
  const appliedAt = new Date().toISOString();
  const nextText = (programText || latest.program_text || "").trim() || latest.program_text;
  if (onBlockStart) { try { onBlockStart(nextText, appliedAt); } catch (_) {} }
  await sbInsert("program_history", {
    athlete_id: athleteId,
    program_text: nextText,
    source,
    block_summary: latest.block_summary || null,
    applied_at: appliedAt,
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

// ─── BLOCK DATES BELONG TO THE BLOCK (T64 Fix 1) ─────────────────────────────
// athletes.program_block_span used to hold the athlete's stated end date with no
// tie to any particular block, so an answer given for block A silently leaked
// into block B, C, D... forever (Will's real "wraps up Sep 7" answer, given
// 08-24 about a block that closed 09-04, is still sitting on his athlete row
// today). The fix is not a new table — it's scoping the SAME jsonb answer to the
// block it was given for, and never trusting it for a different one.

// The athlete's answer, tagged with the block it was given for. blockId is
// program_history.id — the one durable handle a block has. Everything else
// mirrors the message parser's own program_block_span shape.
export function buildBlockSpanAnswer({ blockId, weeks = null, endsAt = null, repeating = false }) {
  return {
    blockId: blockId || null,
    weeks: Number.isFinite(Number(weeks)) && Number(weeks) >= 1 ? Number(weeks) : null,
    endsAt: endsAt || null,
    repeating: !!repeating,
    answeredAt: new Date().toISOString(),
  };
}

// An answer only counts for a block when it says so explicitly — an answer
// recorded before this fix shipped (no blockId at all) is nobody's answer now,
// not a free pass for whichever block happens to be open when it's read.
const answerForBlock = (spanAnswer, blockId) =>
  (spanAnswer && blockId && spanAnswer.blockId === blockId) ? spanAnswer : null;

// Does a freshly stated span (the athlete's own words, just now) CONTRADICT what
// the block's own program text already declares? Only a genuine disagreement is
// a conflict — restating what the text already says, or answering when the text
// says nothing at all, is not. This is the exact gap in Will's 08-24 incident:
// Joe's own reply named the program's real end (Sep 5) in the same breath as
// accepting Will's "Sep 7," and nothing reconciled the two. `stated` is the
// parser's raw program_block_span shape: {weeks, end_date, repeating}. `appliedAt`
// (the open block's own applied_at) is optional but load-bearing for the common
// real-world shape: most programs are numbered weeks with NO printed end date at
// all (Will's real block included — parseBlockSpan reads it as weeks:3, not an
// explicit date), so a same-type-only comparison (weeks-vs-weeks, date-vs-date)
// would miss the exact case this fix exists for. With appliedAt, a weeks-only
// text side and a date-only stated side (or vice versa) are both anchored to the
// block's own start and compared as dates.
export function blockSpanConflict({ programText, stated, appliedAt = null } = {}) {
  if (!stated) return null;
  const fromText = parseBlockSpan(programText);
  if (!fromText.known) return null; // the text doesn't answer this itself — nothing to contradict
  if (fromText.repeating) {
    // Text says it repeats; the athlete just gave it a hard end / length.
    if (stated.repeating) return null;
    if (stated.end_date || stated.weeks) return { textSide: fromText, statedSide: stated };
    return null;
  }
  if (stated.repeating) return { textSide: fromText, statedSide: stated }; // text is finite, athlete says it repeats
  if (stated.end_date && fromText.endDate && stated.end_date !== fromText.endDate) {
    return { textSide: fromText, statedSide: stated };
  }
  if (stated.weeks && fromText.weeks && stated.weeks !== fromText.weeks) {
    return { textSide: fromText, statedSide: stated };
  }
  // Cross-type comparison, anchored to the block's own start. A few days of slop
  // is normal week-boundary rounding (which weekday a "3-week block" technically
  // lands on), not a real disagreement — only a gap wider than that counts.
  const applied = appliedAt ? new Date(appliedAt) : null;
  if (applied && !Number.isNaN(applied.getTime())) {
    const impliedEnd = (weeks) => { const d = new Date(applied); d.setUTCDate(d.getUTCDate() + weeks * 7); return d; };
    if (stated.end_date && !fromText.endDate && fromText.weeks) {
      const diffDays = Math.abs((new Date(`${stated.end_date}T12:00:00Z`) - impliedEnd(fromText.weeks)) / 86400000);
      if (diffDays > 2) return { textSide: fromText, statedSide: stated };
    }
    if (stated.weeks && !stated.end_date && fromText.endDate) {
      const diffDays = Math.abs((new Date(`${fromText.endDate}T12:00:00Z`) - impliedEnd(stated.weeks)) / 86400000);
      if (diffDays > 2) return { textSide: fromText, statedSide: stated };
    }
  }
  return null;
}

// Should the "does this end?" question be asked for the CURRENTLY OPEN block?
// Never twice for the same block: any answer recorded against it — including an
// explicit "no end date" (repeating:true) — ends the asking for good. A
// different block (a new one, or a program whose text changed since the answer
// was given) always re-asks; that is the whole point of scoping it.
export function blockSpanNeedsAsk({ openBlock, programText, spanAnswer } = {}) {
  if (!openBlock || openBlock.completed_at) return false;
  if (openBlock.ends_at) return false; // already resolved (Builder timeline, self-heal, a prior answer)
  const currentText = String(programText ?? openBlock.program_text ?? "").trim();
  const blockText = String(openBlock.program_text || "").trim();
  if (currentText && blockText && programTextIdentity(currentText) !== programTextIdentity(blockText)) return false;
  if (parseBlockSpan(blockText).known) return false; // the text answers it itself
  if (answerForBlock(spanAnswer, openBlock.id)) return false;
  return true;
}

// Full eligibility for the wrap-up/heads-up card (Will's screenshot 1: "your
// program wraps up Sep 7"). `openBlock` is the newest program_history row
// (whatever the caller's own query considers "latest" — this module trusts the
// caller already scoped that query to ONE athlete's most recent row, so "open
// and present" already implies "newest"). `programText` is the athlete's
// CURRENT program_text, checked against the block's own saved text: a program
// that has since been replaced, with program_history's snapshot lagging behind
// (the fire-and-forget write hasn't landed yet), must show nothing rather than a
// date that belonged to different text. `spanAnswer` is the raw
// athletes.program_block_span value. Returns {show, kind, endsAt, reason};
// kind is 'ending'|'ended' only when show is true.
export function wrapCardEligible({ openBlock, programText, spanAnswer, now = null } = {}) {
  const no = (reason) => ({ show: false, kind: null, endsAt: null, reason });
  if (!openBlock || openBlock.completed_at) return no("no_open_block");
  const currentText = String(programText ?? "").trim();
  const blockText = String(openBlock.program_text || "").trim();
  if (currentText && blockText && programTextIdentity(currentText) !== programTextIdentity(blockText)) {
    return no("program_text_changed");
  }
  const fromText = parseBlockSpan(blockText);
  const answer = answerForBlock(spanAnswer, openBlock.id);
  if (fromText.repeating || (answer && answer.repeating)) return no("repeating");

  let endsAt = openBlock.ends_at || null;
  if (!endsAt && answer?.endsAt) endsAt = answer.endsAt;
  if (!endsAt && answer?.weeks && openBlock.applied_at) {
    const end = new Date(openBlock.applied_at);
    end.setDate(end.getDate() + answer.weeks * 7);
    endsAt = end.toISOString();
  }
  if (!endsAt) return no("no_end_known");

  const kind = blockPromptState({ endsAt, now });
  if (!kind) return { show: false, kind: null, endsAt, reason: "not_near_end" };
  return { show: true, kind, endsAt, reason: "ok" };
}

// ─── STATED BLOCK END (T64 S6, verifier BUG-1) ───────────────────────────────
// "No my program wraps up sept 20th" reached the block-span branch (the parser
// populated program_block_span) and got the two-tap confirm. Two ordinary
// paraphrases, "hey just so you know this program actually wraps up Sept 15th,
// not sooner" and "it wraps up October 1st", did not: the parser left the span
// null, Joe answered conversationally, and the date went into athlete_context as
// unscoped free text through the remember-this channel. The statement is
// deterministic, so the model doesn't get a vote (same precedent as
// chatRouting.asksProgramEdit): this recognizes an athlete saying when their
// program / block / cycle ends or how long it runs, and returns the value in the
// parser's own program_block_span shape so the message rides the SAME branch
// (conflict check against the program's text, two-tap confirm, block-scoped
// storage).
//
// statesBlockEnd(message, today) → null | {end_date, weeks, repeating, kind}
//   end_date: "YYYY-MM-DD" resolved against the athlete's LOCAL today (the
//             caller passes new Date() in the browser; local getters read the
//             device zone). A month-day with no year that already passed this
//             year stays this year when it passed within 60 days (they are
//             telling you it ended or is ending now) and rolls to next year
//             otherwise ("wraps up Jan 10" said in December).
//   weeks:    "it's a 6 week block", "my program is 8 weeks long".
//   repeating:"it just repeats", "no end date", "it doesn't end".
// Never fires on: a question, a workout log, a sentence about something that is
// not the program ("my season ends Oct 1", "class ends at 3"), another program
// ("my last block was 8 weeks", "the next block will be 6 weeks"), or a wish
// ("I want my program to end Oct 1"). Unit tested (30+ positives, 20+
// negatives) by scripts/test-program-history.mjs.
const SB_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const SB_MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const SB_NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16 };
const SB_N = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen)";
const SB_WD = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SB_WD_RE = "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const SB_SUBJ = "\\b(?:(?:my|this|the|our|current|present)\\s+)?(?:current\\s+)?(?:training\\s+)?(?:program|programme|block|cycle|plan|mesocycle|meso|phase)(?:'s)?\\b";
const SB_PRON = "\\b(?:it|this(?:\\s+one)?)\\b(?:\\s+(?:actually|really|officially|just|only|technically|probably|basically))*";
const SB_OTHER_PROGRAM = /\b(?:next|new|last|previous|old|former|upcoming|other|his|her|their|coach'?s|friend'?s)\s+(?:training\s+)?(?:program|programme|block|cycle|plan|phase|one)\b/i;
const SB_NON_PROGRAM = /\b(season|class(?:es)?|school|semester|term|trip|vacation|camp|meet|competition|comp|game|tournament|practice|lease|sale|job|shift|work|session|workout|deload|cut|bulk|diet|event|race|marathon|gym|cruise|visit|surgery|rehab|therapy)\b/i;
const SB_VERB = "(?:wraps?\\s+up|wrapping\\s+up|will\\s+wrap\\s+up|ends?|ending|will\\s+end|finish(?:es)?|finishing|will\\s+finish|is\\s+finished|(?:runs?|running|goes|going|go|lasts?)\\s+(?:through|thru|until|till|til|to)|is\\s+over|'s\\s+over|will\\s+be\\s+over|is\\s+done|'s\\s+done|will\\s+be\\s+done)\\b";
const SB_HEDGE = /\b(if|unless|would|could|might|wish|hope|want|wanted|was|were|ended|finished)\b/i;
const SB_LOG = /\d+\s*[x×]\s*\d+|@\s*\d|\b\d+(?:\.\d+)?\s*(?:lbs?|kgs?|pounds|kilos)\b/i;
const SB_QUESTION_START = /^\s*(?:when|what|what's|how|does|do|is|are|will|can|could|should|would|which|did|has|have)\b/i;

const sbIso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const sbValid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const sbDayNum = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;
const sbNum = (w) => { const s = String(w || "").toLowerCase(); return SB_NUMW[s] || (/^\d+$/.test(s) ? parseInt(s, 10) : null); };
const sbMonth = (name) => SB_MONTHS[String(name || "").toLowerCase().slice(0, 3)] || null;

// Month-day with no stated year → the sensible year (see header).
function sbResolveYear(m, d, t) {
  let y = t.y;
  if (!sbValid(y, m, d)) return null;
  if (sbDayNum(y, m, d) < sbDayNum(t.y, t.m, t.d) - 60) y += 1;
  return sbValid(y, m, d) ? sbIso(y, m, d) : null;
}
const sbAddDays = (t, n) => { const x = new Date(Date.UTC(t.y, t.m - 1, t.d + n)); return sbIso(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); };

// The date named at the START of `tail` (the words right after the verb).
function sbDateIn(tail, t) {
  const s = tail.replace(/^[\s,:-]*(?:(?:on|by|around|about|at|in|as\s+of|sometime|the\s+week\s+of)\s+)*/i, "");
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})\b/))) return sbValid(+m[1], +m[2], +m[3]) ? sbIso(+m[1], +m[2], +m[3]) : null;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const mo = +m[1], d = +m[2];
    if (m[3]) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return sbValid(y, mo, d) ? sbIso(y, mo, d) : null; }
    return sbResolveYear(mo, d, t);
  }
  if ((m = s.match(new RegExp(`^${SB_MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(\\d{4})\\b)?`, "i")))) {
    const mo = sbMonth(m[1]), d = +m[2];
    if (m[3]) return sbValid(+m[3], mo, d) ? sbIso(+m[3], mo, d) : null;
    return sbResolveYear(mo, d, t);
  }
  if ((m = s.match(new RegExp(`^(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+${SB_MONTH}(?:\\s*,?\\s*(\\d{4})\\b)?`, "i")))) {
    const mo = sbMonth(m[2]), d = +m[1];
    if (m[3]) return sbValid(+m[3], mo, d) ? sbIso(+m[3], mo, d) : null;
    return sbResolveYear(mo, d, t);
  }
  if ((m = s.match(new RegExp(`^(?:the\\s+)?end\\s+of\\s+(?:(the|this|next)\\s+month|${SB_MONTH})`, "i")))) {
    let y = t.y, mo = t.m;
    if (m[1] && m[1].toLowerCase() === "next") { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    else if (m[2]) { mo = sbMonth(m[2]); if (sbDayNum(y, mo, 28) < sbDayNum(t.y, t.m, t.d) - 60) y += 1; }
    return sbIso(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate());
  }
  if ((m = s.match(/^tomorrow\b/i))) return sbAddDays(t, 1);
  if ((m = s.match(new RegExp(`^(?:(next|this|on)\\s+)?${SB_WD_RE}\\b`, "i")))) {
    const idx = SB_WD.findIndex((w) => w.startsWith(m[2].toLowerCase().slice(0, 3)));
    let diff = (idx - t.wd + 7) % 7;
    if (diff === 0) diff = 7; // "ends Friday" said on a Friday = next Friday
    // "next Friday" said early in the week means the Friday of NEXT week.
    if (m[1] && m[1].toLowerCase() === "next" && t.wd + diff <= 6) diff += 7;
    return sbAddDays(t, diff);
  }
  if ((m = s.match(/^(?:the\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th))\b/i))) {
    const d = +(m[1] || m[2]);
    let y = t.y, mo = t.m;
    if (d < t.d) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    return sbValid(y, mo, d) ? sbIso(y, mo, d) : null;
  }
  return null;
}

export function statesBlockEnd(message, today = new Date()) {
  const raw = String(message || "");
  if (!raw.trim() || SB_LOG.test(raw)) return null;
  const now = today instanceof Date ? today : new Date(today);
  const t = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), wd: now.getDay() };
  // Sentences, keeping the terminator so a question can be told apart.
  const sentences = raw.match(/[^.!?\n]+[.!?]?/g) || [];
  for (const sent of sentences) {
    const s = sent.trim();
    if (!s || /\?\s*$/.test(s) || SB_QUESTION_START.test(s)) continue;
    if (SB_OTHER_PROGRAM.test(s)) continue;
    const subjRe = new RegExp(`(${SB_SUBJ})`, "i");
    const hasSubject = subjRe.test(s);
    const nonProgram = SB_NON_PROGRAM.test(s);
    // "it"/"this" only stands in for the program when nothing else is named.
    const pronounOk = !nonProgram;

    // ── repeating ──
    const repRe = new RegExp(`(?:${SB_SUBJ}|${SB_PRON})[^.!?\\n]{0,20}?\\b(?:just\\s+)?(?:repeats|loops|keeps\\s+going|is\\s+ongoing|'s\\s+ongoing|doesn'?t\\s+(?:end|have\\s+an\\s+end)|does\\s+not\\s+end|never\\s+ends|has\\s+no\\s+end)`, "i");
    const rm = s.match(repRe);
    if (rm && (subjRe.test(rm[0]) || pronounOk) && !nonProgram) return { end_date: null, weeks: null, repeating: true, kind: "repeating" };
    if (/\bno\s+end\s+date\b|\bsame\s+(?:week|thing)\s+every\s+week\b|\brun\s+it\s+until\s+i\s+(?:change|switch|stop)\b/i.test(s) && !nonProgram) {
      return { end_date: null, weeks: null, repeating: true, kind: "repeating" };
    }

    // ── weeks remaining ("3 more weeks on this block", "4 weeks left in my program") ──
    const leftRe = new RegExp(`\\b${SB_N}\\s+(?:more\\s+)?weeks?\\s+(?:left|to\\s+go|remaining)\\b|\\b${SB_N}\\s+more\\s+weeks?\\b`, "i");
    const lm = s.match(leftRe);
    if (lm && (hasSubject || (pronounOk && /\bit\b/i.test(s))) && !nonProgram) {
      const n = sbNum(lm[1] || lm[2]);
      if (n && n >= 1 && n <= 52) return { end_date: sbAddDays(t, n * 7), weeks: null, repeating: false, kind: "date" };
    }

    // ── length in weeks ──
    const wkRes = [
      new RegExp(`(?:${SB_SUBJ}|${SB_PRON})[^.!?\\n]{0,15}?\\b(?:is|'s|runs|lasts|goes|will\\s+(?:be|run|last))(?:\\s+for)?\\s+(?:a|an\\s+)?\\s*${SB_N}[-\\s]?weeks?\\b`, "i"),
      new RegExp(`\\b(?:it'?s|it\\s+is|this\\s+is|i'?m\\s+(?:on|running|doing|in))\\s+(?:a|an|my)\\s+${SB_N}[-\\s]?weeks?(?:[-\\s]long)?\\s+(?:program|programme|block|cycle|plan|meso(?:cycle)?|phase)\\b`, "i"),
    ];
    for (const re of wkRes) {
      const m = s.match(re);
      if (!m) continue;
      if (!subjRe.test(m[0]) && !pronounOk) continue;
      const n = sbNum(m[m.length - 1]);
      if (n && n >= 1 && n <= 52) return { end_date: null, weeks: n, repeating: false, kind: "weeks" };
    }

    // ── an end date ──
    const lastDayRe = new RegExp(`\\b(?:the\\s+)?last\\s+(?:day|week)(?:\\s+of\\s+(?:${SB_SUBJ}|it))?\\s+(?:is|will\\s+be|'s)\\b`, "i");
    const endRe = new RegExp(`(${SB_SUBJ}|${SB_PRON})([^.!?\\n]{0,30}?)\\b${SB_VERB}`, "ig");
    const tries = [];
    let m;
    while ((m = endRe.exec(s))) {
      const subj = m[1];
      if (!subjRe.test(subj) && !pronounOk) continue;
      if (SB_HEDGE.test(m[2] || "")) continue;
      if (/^\s*(?:'s\s+)?(?:week|weeks|day|days|session|sessions|workout|workouts)\b/i.test(m[2] || "")) continue; // "my program week ends Sunday" is the week, not the program
      tries.push(m.index + m[0].length);
    }
    const ld = s.match(lastDayRe);
    if (ld && (hasSubject || pronounOk) && !nonProgram) tries.push(ld.index + ld[0].length);
    for (const at of tries) {
      if (/\b(if|unless|wish|hope|want|wanted)\b/i.test(s.slice(0, at))) continue;
      const date = sbDateIn(s.slice(at, at + 45), t);
      if (date) return { end_date: date, weeks: null, repeating: false, kind: "date" };
    }
  }
  return null;
}

// Which span rides the block-span branch this turn. The detector is
// deterministic, so when it fires it wins; when the parser also populated a
// span and the two disagree, the caller logs it (error_events) so the parser's
// misses stay visible. `blockEndStated` tells the remember-this channel that
// this message's fact already has its one home (the block), so it must not be
// saved a second time as a free-text note.
export function resolveStatedSpan({ parserSpan = null, detected = null } = {}) {
  const has = (s) => !!(s && (s.repeating === true || Number(s.weeks) >= 1 || s.end_date));
  if (!detected) {
    return has(parserSpan)
      ? { span: parserSpan, source: "parser", disagree: false, blockEndStated: true }
      : { span: null, source: null, disagree: false, blockEndStated: false };
  }
  const d = { weeks: detected.weeks ?? null, end_date: detected.end_date ?? null, repeating: detected.repeating === true };
  if (!has(parserSpan)) return { span: d, source: "detector", disagree: false, blockEndStated: true };
  const pw = Number(parserSpan.weeks) >= 1 ? Number(parserSpan.weeks) : null;
  const same = (parserSpan.end_date || null) === d.end_date && pw === d.weeks && (parserSpan.repeating === true) === d.repeating;
  return { span: d, source: "detector", disagree: !same, blockEndStated: true };
}
