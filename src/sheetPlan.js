// ─── THE SHEET AND THE GENERATORS (Will, 09-29) ──────────────────────────────
// A log sheet the athlete has changed is their record of the session. Three
// things in the app build a fresh draft and park it: Joe's prefill_log_sheet
// tool, the lock-screen card refresh, and the in-chat swap. Each one used to
// write straight over the park, so typed work was replaced by a clean draft.
//
// This is the arbitration the AI contract asks for (rule 3: code validates
// every tool call and may correct it; rule 4: whoever decides second reads
// what was decided first). The athlete decided first, on the sheet.
//
// Two answers only. Nothing said in CHAT ever rewrites a sheet the athlete
// changed, by model or by code: the first build of this rule sent the chat
// message through the sheet's edit call, and on the simulator a mistyped
// "starting my workout" came back as a rebuilt sheet with their added lift
// gone. A change to their own sheet goes through the sheet itself: they type
// on it, or open it and tell Joe there, where they see the result at once.
//
// Pure. Suite: scripts/test-sheet-plan.mjs.

import { qlPositionConflict } from "./quicklog.js";

// The athlete asked for a clean sheet and NAMED the sheet. Deliberately
// narrow: this is the one phrase that replaces their own work, so a bare
// "start over" (a set, a rep, a warm-up) must never match.
const FRESH_RE = /\b(?:start|reset|redo|rebuild|clear|wipe)\s+(?:(?:the|my|that|this)\s+)?(?:log\s+)?(?:sheet|log|logger)\b(?:\s+over)?|\b(?:fresh|new|clean)\s+(?:log\s+)?(?:sheet|log)\b/i;
export const asksFreshSheet = (msg) => FRESH_RE.test(String(msg || ""));

// The session the athlete NAMED after the sheet was last touched, or null.
// Only their own statement counts (the stored position override carries when
// they said it). The resolver's position is never used here: it moves on its
// own when a lift is logged mid-workout, and a sheet must not be rebuilt
// because the app's idea of "today" drifted under it.
export const namedPositionSince = (override, savedAt) => {
  if (!override || typeof override !== "object") return null;
  const at = Date.parse(override.at || "");
  if (!Number.isFinite(at) || at <= (savedAt || 0)) return null;
  if (override.week == null && override.day == null) return null;
  return { week: override.week ?? null, day: override.day ?? null };
};

// What a generator may do to the park it is about to write over.
//   "generate": build a fresh draft and park it. Nothing of the athlete's is
//               there, or they asked for a different session or a clean sheet.
//   "keep":     leave the park exactly as it is; raise the bar, re-show the card.
// rec:      what qlLoad returned (so expiry and staleness already ran).
// reason:   "prefill" (Joe's tool) | "pin" (card refresh) | "swap" (an in-chat
//           exercise change) | "position" (they said which day they are on) |
//           "switch" (the Different Workout button).
// position: the session they named since the sheet was last touched
//           (namedPositionSince), or null. An unknown on either side is never
//           a conflict.
export const sheetRegenPlan = ({ rec, reason, msg, position } = {}) => {
  if (!rec || !rec.draft || rec.prebuilt) return "generate";
  if (reason === "switch") return "generate";
  if (asksFreshSheet(msg)) return "generate";
  if (qlPositionConflict(rec.position, position)) return "generate";
  return "keep";
};

// The fact Joe is handed when the sheet is theirs (rule 1: facts come from
// code). Dynamic context only; the card carries the standing rule.
export const sheetFactLine = (rec) =>
  rec && rec.draft && !rec.prebuilt && rec.dock
    ? "\n\nLOG SHEET (fact from the app): today's session is started and the sheet carries the athlete's own changes. The app keeps their text exactly as they left it. Nothing said in chat changes it, and the app will not rebuild it unless they name a different session or ask for a fresh sheet. If they want something changed on it, they type on the sheet, or open it and tell you there. Do not say the sheet was updated, rebuilt, reset or prefilled this turn."
    : "";
