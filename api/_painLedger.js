// Server-side alias for the pain ledger — same pattern as _units.js / _grit.js.
// api/* reads pain state through here (the proof letter, the check-in question
// bank, the coach push); never re-derive pain status server-side.
export * from "../src/painLedger.js";
export * from "../src/programPurpose.js";
