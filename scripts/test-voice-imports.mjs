// ─── ONE VOICE SOURCE, EVERY PROSE PROMPT (T64 S4, AI contract rule 7) ───────
// Static regression net: every prompt that writes words a person reads imports
// the voice from src/ai/voice.js (server: api/_voice.js) instead of carrying its
// own copy, and every model-text surface passes the one output gate. A new
// prose prompt that re-types "You are Coach Joe Thomas" fails HERE.
import fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(join(root, p), "utf8");
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log(`  ✗ ${l}`); } };

// 1. no second copy of an identity line anywhere outside the voice source
const walk = (d, out = []) => { for (const f of fs.readdirSync(join(root, d))) { const p = `${d}/${f}`; const st = fs.statSync(join(root, p)); if (st.isDirectory()) { if (!/node_modules|assets/.test(p)) walk(p, out); } else if (/\.(js|jsx)$/.test(f)) out.push(p); } return out; };
for (const f of [...walk("src"), ...walk("api")]) {
  if (f === "src/ai/voice.js") continue;
  const t = read(f);
  ok(!/You are Coach Joe\b/.test(t), `${f}: no hand-typed "You are Coach Joe" identity`);
  ok(!/You are WILCO, a strength coach's AI assistant/.test(t), `${f}: no hand-typed coach-assistant identity`);
}

// 2. the checklist (audit Task 2a): each prose prompt imports the voice source
const CHECK = [
  ["src/ai/card.js", /VOICE_LAW/, "main chat (mastermind card TIER1)"],
  ["src/ai/card.js", /VOICE_COACH/, "TIER1_WILCO_COACH"],
  ["src/App.jsx", /const JOEBOT_STATIC_SYS = `\$\{JOE_IDENTITY\}[\s\S]{0,40}\$\{VOICE_LAW\}/, "legacy JOEBOT_STATIC_SYS"],
  ["src/checkinAgenda.js", /\$\{VOICE_ATHLETE\}/, "check-in turn (reply + clarify, one call)"],
  ["src/App.jsx", /const QL_DRAFT_SYS = `[\s\S]*?\$\{VOICE_ATHLETE\}[\s\S]*?`;/, "QL_DRAFT_SYS focus note"],
  ["src/App.jsx", /const QL_EDIT_SYS = `[\s\S]*?\$\{VOICE_ATHLETE\}`;/, "QL_EDIT_SYS focus note"],
  ["src/App.jsx", /const REC_DRAFT_SYS = `[\s\S]*?\$\{VOICE_ATHLETE\}`;/, "REC_DRAFT_SYS"],
  ["src/programHistory.js", /const RECAP_SYS =[\s\S]*?VOICE_ATHLETE;/, "RECAP_SYS"],
  ["src/programHistory.js", /const ONGOING_RECAP_SYS =[\s\S]*?VOICE_ATHLETE;/, "ONGOING_RECAP_SYS"],
  ["src/programHistory.js", /const RECAP_SHORT_SYS =[\s\S]*?VOICE_ATHLETE;/, "short recap"],
  ["src/App.jsx", /const MEMORY_EDIT_SYS = `\$\{JOE_IDENTITY\}[\s\S]*?\$\{VOICE_ATHLETE\}/, "MEMORY_EDIT_SYS"],
  ["src/App.jsx", /reviewing still frames[\s\S]{0,1200}\$\{VOICE_ATHLETE\}/, "video form review"],
  ["src/programBuilder.js", /VOICE_COACH : VOICE_ATHLETE/, "builder interviewer"],
  ["src/programBuilder.js", /\$\{VOICE_FORMAT\} \$\{VOICE_CLEAN\}/, "builder drafter prose lines"],
  ["src/changeRequest.js", /\$\{VOICE_COACH\}/, "change request drafts"],
  ["src/coach.jsx", /\$\{WILCO_COACH_VOICE\}[\s\S]*mid morning-brief/, "coach morning-brief Q&A"],
  ["src/coach.jsx", /\$\{WILCO_COACH_VOICE\}\s*You are mid-check-in with the coach/, "coach check-in reaction"],
  ["api/_proof.js", /from "\.\/_voice\.js"/, "proof letter (server, via api/_voice.js)"],
  ["api/_proof.js", /const COACH_VOICE = `\$\{JOE_IDENTITY\}[\s\S]*?\$\{VOICE_ATHLETE\}/, "proof letter COACH_VOICE"],
  ["api/_proof.js", /const COACH_EDITION_VOICE = `\$\{JOE_IDENTITY\}[\s\S]*?\$\{VOICE_COACH\}/, "coach edition voice"],
];
for (const [f, re, what] of CHECK) ok(re.test(read(f)), `imports the voice: ${what} (${f})`);

// 3. every model-text surface passes the gate
const GATED = [
  ["src/App.jsx", /reply = gateText\("chat", reply\)/, "chat settle"],
  ["src/App.jsx", /replyGate\("chat", reply, \{toolCalls:/, "chat claim guard after tool backstop"],
  ["src/App.jsx", /<StreamText text=\{renderGate\(m\.content\)\}\/>/, "chat renderer (stream + history)"],
  ["src/App.jsx", /renderGate\(\[\.\.\.session\.entries\]/, "My Log last reply"],
  ["src/App.jsx", /gateText\("checkin", step\.reply/, "check-in reply"],
  ["src/App.jsx", /m\.role==="user" \? m\.content : renderGate\(m\.content\)/, "check-in renderer (athlete text untouched)"],
  ["src/App.jsx", /analysis = gateText\("video_review"/, "video review"],
  ["src/App.jsx", /gateFields\("rec", v\.rec/, "program rec title/summary/why"],
  ["src/App.jsx", /gateText\("ql_note"/, "log-sheet focus note"],
  ["src/App.jsx", /renderGate\(sp\.notes\)/, "log-sheet focus note mid-stream"],
  ["src/App.jsx", /gateText\("memory", plan\.reply\)/, "memory ask-Joe reply"],
  ["src/programHistory.js", /gateText\("recap"/, "recaps"],
  ["src/programBuilder.js", /gateText\("builder"/, "builder interviewer"],
  ["src/changeRequest.js", /gateText\("change_request"/, "change requests"],
  ["src/coach.jsx", /gateText\("coach"/, "coach replies"],
  ["api/_proof.js", /gateText\("proof_letter"/, "proof letter sections (server)"],
];
for (const [f, re, what] of GATED) ok(re.test(read(f)), `gated: ${what} (${f})`);

console.log(`\nvoice-imports: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
