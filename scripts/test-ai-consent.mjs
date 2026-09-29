// ─── AI PROCESSING CONSENT REGRESSION SUITE ──────────────────────────────────
// App Store guideline 5.1.2(i): before any personal data reaches a third-party
// AI, the app must clearly disclose it, name the provider, and get explicit
// permission — a line inside Terms/Privacy doesn't count. Source-contract
// checks only (in the style of scripts/test-tier-trial.mjs) since exercising
// the real signup/login flow needs a browser — that's tests/smoke/tier-trial.spec.js
// and tests/smoke/install-prompt.spec.js, which walk the 2-step signup consent.
//
// Run with: node scripts/test-ai-consent.mjs

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };

const legal = readFileSync(new URL("../src/legal.jsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const data = readFileSync(new URL("../api/data.js", import.meta.url), "utf8");
const identity = readFileSync(new URL("../api/identity.js", import.meta.url), "utf8");

console.log("legal.jsx — the disclosure itself:");
ok(legal.includes('export const AI_CONSENT_VERSION = "2026-09-29"'), "AI_CONSENT_VERSION is exported with today's date");
ok(/function AiConsentBody/.test(legal), "a dedicated AI-consent body component exists (not folded into the Terms/Privacy renderer)");
ok(legal.includes("Anthropic"), "the provider is named: Anthropic");
ok(legal.includes("Claude AI model"), "the model is named: Claude");
ok(/what is shared|messages to the coach/i.test(legal) && legal.includes("workout logs") && legal.includes("injury and pain notes") && legal.includes("form check"),
  "the disclosure lists what is shared: chat messages, workout logs/program, goals, injury/pain notes, form-check video frames");
ok(legal.includes("You can delete your account and your data at any time in Settings"),
  "the disclosure states account/data deletion is available any time in Settings");
// Task spec: only claim Anthropic doesn't train on WILCO's data if that sentence
// ALREADY exists in the Privacy text — it doesn't (checked 2026-09-29), so the
// AI consent body must not invent the claim.
ok(!/Anthropic does not use (it|your data|this data) to train/i.test(legal),
  "does NOT claim Anthropic excludes WILCO data from model training (not in PRIVACY_TEXT, so not invented here)");

console.log("\nConsentFlow — two steps, the AI block rides on the Privacy step:");
{
  const cf = legal.slice(legal.indexOf("export function ConsentFlow"));
  const iParental = cf.indexOf('stage === "parental"');
  const iTerms = cf.indexOf('stage === "terms"');
  ok(iParental !== -1 && iTerms !== -1 && iParental < iTerms, "parental then terms stages exist, in order");
  ok(!/stage === "ai"|setStage\("ai"\)|key="ai"/.test(cf), "there is NO separate ai stage in ConsentFlow");
  ok(!/STEP \d OF 3/.test(cf), "no 3-step kickers remain");
  const termsBlock = cf.slice(iTerms);
  ok(/kicker="STEP 1 OF 2"/.test(termsBlock) && /kicker="STEP 2 OF 2"/.test(termsBlock), "kickers read STEP 1 OF 2 and STEP 2 OF 2");
  ok(/onAccept=\{\(\) => setStage\("privacy"\)\}/.test(termsBlock), "accepting Terms advances straight to privacy");
  const priv = cf.slice(cf.indexOf('<LegalModal key="privacy"'));
  ok(/<LegalModal key="privacy"[^>]*\bleadBlock\b/.test(priv), "the privacy stage renders LegalModal with leadBlock (the AI block above the policy)");
  ok(priv.includes('checkboxLabel="I agree to the Privacy Policy and allow WILCO to send my training data to Anthropic to power my coaching."'),
    "the one privacy checkbox label names the policy, Anthropic and the purpose, exactly");
  ok((cf.match(/checkboxLabel=/g) || []).length === 3, "signup has exactly three checkboxes at most (parental, terms, privacy), none added");
  const modal = legal.slice(legal.indexOf("export function LegalModal"), legal.indexOf("export function ConsentFlow"));
  ok(/<AiConsentBody C=\{C\} role=\{aiRole\|\|"athlete"\} signup \/>/.test(modal) && modal.includes("AI and your data"),
    "leadBlock renders AiConsentBody with a small 'AI and your data' heading inside the scroll body");
  ok(/scrollRef\} onScroll/.test(modal) && /noteScroll\(scrollRef\.current\)/.test(modal) && /checked && readToEnd && !busy/.test(modal),
    "the read-to-end scroll gate is still wired to the same scroll area and the checkbox");
  ok(/noCheckbox \? !busy/.test(modal) && /!readOnly && !noCheckbox && \(\s*<label/.test(modal),
    "noCheckbox hides the checkbox and enables the primary button at once");
}

console.log("\nApp.jsx — recording acceptance on signup:");
ok(/const recordAcceptances = async \(athleteId, isMinor\) => \{[\s\S]{0,400}"ai_processing"/.test(app),
  "recordAcceptances writes a document:\"ai_processing\" row");
ok(/docs = \["terms","ai_processing","privacy"/.test(app), "ai_processing is recorded alongside terms/privacy on every signup, not just minors");
ok(/versionFor = .*AI_CONSENT_VERSION/.test(app), "the ai_processing row is stamped with AI_CONSENT_VERSION, not TERMS_VERSION/PRIVACY_VERSION");
ok(/import \{ ConsentFlow, LegalModal, TERMS_VERSION, PRIVACY_VERSION, AI_CONSENT_VERSION \} from "\.\/legal\.jsx"/.test(app),
  "App.jsx imports AI_CONSENT_VERSION from legal.jsx");

console.log("\nApp.jsx — the existing-account login gate:");
ok(/function AiConsentGate\(/.test(app), "AiConsentGate component exists");
ok(/let AI_CONSENT_OK = false;/.test(app), "a single module-level consent flag exists (one gate, not per-call-site checks)");
ok((app.match(/if\(!AI_CONSENT_OK\) throw new Error\("AI permission required"\);/g) || []).length === 2,
  "both askClaude and askClaudeStream refuse to fire before consent is granted");
ok(/async function readAiConsentRow\(athleteId\)/.test(app), "a dedicated read checks the athlete's legal_acceptances row for ai_processing");
ok(/document=eq\.ai_processing/.test(app), "the read filters on document=eq.ai_processing");
ok(/view==="athlete"&&athlete\) return \(\s*<AiConsentGate role="athlete"/.test(app), "the athlete view is wrapped in AiConsentGate before it can mount");
ok(/view==="coach"&&coach\) return \(\s*<AiConsentGate role="coach"/.test(app), "the coach view is wrapped in AiConsentGate before it can mount");
ok(/onDecline=\{\(\)=>\{[\s\S]{0,200}setView\("login"\);/.test(app), "declining the athlete gate signs out to the login screen");
ok(/onDecline=\{\(\)=>\{[\s\S]{0,200}setView\("coachLogin"\);/.test(app), "declining the coach gate signs out to the coach login screen");
ok(/function resetAiConsentGate\(\)/.test(app) && (app.match(/resetAiConsentGate\(\)/g) || []).length >= 3,
  "the gate resets on logout/decline (not just closes), so the next sign-in on this device is asked again");

{
  const gate = app.slice(app.indexOf("function AiConsentGate("), app.indexOf("function WilcoRoot"));
  const card = gate.slice(gate.indexOf("<LegalModal"));
  ok(/<LegalModal[^>]*\bnoCheckbox\b/.test(card) && !/checkboxLabel/.test(card), "the login gate card has no checkbox");
  ok(card.includes('primaryLabel="Allow and continue"'), 'the gate primary button reads "Allow and continue"');
  ok(card.includes('declineLabel="Not now"') && /onDecline=\{onDecline\}/.test(card), 'the quiet decline link reads "Not now" and still signs out');
}

console.log("\napi/data.js — the read gateway can actually answer the question:");
ok(/legal_acceptances: "athlete_id",/.test(data), "legal_acceptances is in READ_OWN_COL (previously write-only — the classic DB-CHECK-vs-gateway-allowlist gap)");

console.log("\nsupabase/migrations — the DB CHECK constraint matches what the app writes:");
{
  const mig = readFileSync(new URL("../supabase/migrations/20260929_legal_acceptances_ai_processing.sql", import.meta.url), "utf8");
  ok(mig.includes("'ai_processing'::text"), "the migration adds ai_processing to legal_acceptances_document_check");
}

console.log("\nSettings — the disclosure can be reopened:");
ok(/AI and your data/.test(app), 'a Settings row titled "AI and your data" exists');
ok(/<LegalModal C=\{CA\} aiConsent readOnly/.test(app), "reopening it uses LegalModal in readOnly mode (no re-ask, just re-show)");

console.log("\nlegal.jsx — LegalModal supports the readOnly reopen without a fake accept:");
ok(/readOnly\s*\}\)/.test(legal) || /readOnly\s*\)/.test(legal), "LegalModal accepts a readOnly prop");
ok(/canContinue = readOnly \? true/.test(legal), "readOnly bypasses the checkbox/scroll gate instead of requiring a silent auto-check");

console.log(`\n${fail === 0 ? `All ${pass} checks green.` : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
