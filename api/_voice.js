// Server-side alias for the one voice source and the one output gate (T64 S4),
// same pattern as _units.js / _grit.js. Server prompts import their voice from
// here and proof letters pass the gate before they are stored. Never redefine a
// voice rule in api/*.
import { replyGate, gateText, gateFields, scrubProfanity, hasBannedWord } from "../src/replyGate.js";
export * from "../src/ai/voice.js";
export { replyGate, gateText, gateFields, scrubProfanity, hasBannedWord };
