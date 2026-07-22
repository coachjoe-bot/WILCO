// ─── PROGRAM DIFF — pure line-diff + placement + merge-safety guard ───────────
// Backs the coach-side staged program edit flow (coach.jsx AthleteDetail): Claude
// proposes a full rewritten program text for ONE requested change, and this module
// (a) shows the coach exactly what moved via a classic LCS line diff, (b) finds
// where in the CURRENT program a lift already lives so the diff review can say
// "Day 2 — replaces …", and (c) guards against a bad/truncated/over-eager rewrite
// ever silently overwriting the coach's program (same spirit as App.jsx's
// propagate1RM length guard). React-free, side-effect-free — unit tested by
// scripts/test-program-diff.mjs.

// ── LCS line diff ─────────────────────────────────────────────────────────────
// Simple O(n*m) DP. Fine up to a few hundred lines (a written program is never
// anywhere near that); above ~600 lines this would get slow, which is an
// acceptable ceiling for a hand-written training program.
export function lineDiff(oldText, newText) {
  const a = String(oldText || "").split("\n");
  const b = String(newText || "").split("\n");
  const n = a.length, m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++; }
    else { out.push({ type: "add", text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: "del", text: a[i] }); i++; }
  while (j < m) { out.push({ type: "add", text: b[j] }); j++; }
  return out;
}

// ── diff stats ────────────────────────────────────────────────────────────────
export function diffStats(diff) {
  let added = 0, removed = 0, unchanged = 0;
  for (const d of diff || []) {
    if (d.type === "add") added++;
    else if (d.type === "del") removed++;
    else unchanged++;
  }
  const oldLineCount = removed + unchanged;
  const changedRatio = (added + removed) / Math.max(1, oldLineCount);
  return { added, removed, unchanged, changedRatio };
}

// ── placement finder ──────────────────────────────────────────────────────────
// Normalize for matching: × → x, collapse whitespace, lowercase.
const normLine = (s) => String(s || "").replace(/×/g, "x").replace(/\s+/g, " ").trim().toLowerCase();

// Significant words of a lift name — drop tiny connector words so "Back Squat"
// matches a line like "3. Squat (back) 3x5" without requiring an exact phrase.
const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or", "for", "with"]);
const sigWords = (lift) =>
  normLine(lift).split(/[^a-z0-9]+/).filter((w) => w && !STOPWORDS.has(w));

const DAY_HEADER_RE = /^(day|week|mon|tue|wed|thu|fri|sat|sun|upper|lower|push|pull|full)/i;

export function findPlacement(programText, lift) {
  if (!lift || !String(lift).trim()) return null;
  const lines = String(programText || "").split("\n");
  const words = sigWords(lift);
  if (!words.length) return null;

  let dayLabel = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const norm = normLine(raw);
    if (DAY_HEADER_RE.test(raw.trim()) || /\bday\b/i.test(raw)) {
      // Track the nearest preceding header, trimmed for display.
      dayLabel = raw.trim().replace(/^#+\s*/, "");
    }
    if (!norm) continue;
    // Every significant word of the lift name must appear in the line — strict
    // enough that "Squat" doesn't fire on an unrelated line containing one short
    // stray word, but loose enough to match "Back Squat" against "3. Squat (back)".
    if (words.every((w) => norm.includes(w))) {
      return { dayLabel, lineIndex: idx, currentLine: raw.trim() };
    }
  }
  return null;
}

// ── merge guard ────────────────────────────────────────────────────────────────
// Strips markdown fences if present, then rejects the merge outright when the
// result looks wrong rather than trusting a possibly-truncated/over-eager rewrite.
export function mergeGuard(oldText, rawNewText) {
  let text = String(rawNewText || "");
  // Strip a leading/trailing ``` fence (with optional language tag) if the whole
  // response is wrapped in one — Claude sometimes fences "plain text" replies
  // despite being told not to.
  const fenced = text.trim().match(/^```[a-zA-Z0-9]*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1];
  text = text.trim();

  if (!text) return { ok: false, text, reason: "Claude returned an empty program." };

  const old = String(oldText || "");
  if (old.length >= 200 && text.length < old.length * 0.5) {
    return { ok: false, text, reason: "The result was much shorter than your current program — looks truncated." };
  }

  const diff = lineDiff(old, text);
  const stats = diffStats(diff);
  if (stats.changedRatio > 0.6) {
    return { ok: false, text, reason: "That rewrote most of the program instead of making one change." };
  }

  return { ok: true, text };
}
