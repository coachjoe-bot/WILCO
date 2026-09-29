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
// It reads messages only through readers the app already has: the start and
// what's-today intents (sessionCard.js), the swap words (sessionCard.js), and
// the equipment/condition words (changeScope.js). The one new reader is the
// explicit ask for a clean sheet.
//
// Pure. Suite: scripts/test-sheet-plan.mjs.

import { qlPositionConflict } from "./quicklog.js";
import { asksStartingWorkout, asksTodaysWorkout, saysSwap } from "./sessionCard.js";
import { hasTempCondition } from "./changeScope.js";

// The athlete asked for a clean sheet in so many words. The one phrase that
// replaces their own edits without a day change.
const FRESH_RE = /\b(?:start (?:it |the (?:sheet|log|workout) )?over|start(?:ing)? fresh|fresh (?:sheet|log|start)|from scratch|reset (?:it|the (?:sheet|log|workout))|redo (?:it|the (?:sheet|log|workout))|rebuild (?:it|the (?:sheet|log|workout))|clear (?:the|my) (?:sheet|log))\b/i;
export const asksFreshSheet = (msg) => FRESH_RE.test(String(msg || ""));

// A start (or a what's-today ask) that changes nothing about the session.
export const isPlainStart = (msg) => {
  const t = String(msg || "");
  return (asksStartingWorkout(t) || asksTodaysWorkout(t)) && !saysSwap(t) && !hasTempCondition([t]);
};

// What a generator may do to the park it is about to write over.
//   "generate": build a fresh draft and park it. Nothing of the athlete's is
//               there, or they asked for a different session.
//   "keep":     leave the park exactly as it is; raise the bar.
//   "edit":     apply the message to THEIR text as an instruction (the sheet's
//               own "tell Joe what to change" call, which returns the draft
//               unchanged when the message is not an edit).
// rec:      what qlLoad returned (so expiry and staleness already ran).
// reason:   "prefill" (Joe's tool) | "pin" (card refresh, nothing new said) |
//           "swap" (an in-chat exercise change) | "position" (they said which
//           day they are on) | "switch" (the Different Workout button).
// position: the day the resolver points at now, when known.
export const sheetRegenPlan = ({ rec, reason, msg, position } = {}) => {
  if (!rec || !rec.draft || rec.prebuilt) return "generate";
  if (reason === "switch") return "generate";
  if (asksFreshSheet(msg)) return "generate";
  if (qlPositionConflict(rec.position, position)) return "generate";
  if (reason === "position" || reason === "pin") return "keep";
  if (reason === "swap") return "edit";
  return !String(msg || "").trim() || isPlainStart(msg) ? "keep" : "edit";
};
