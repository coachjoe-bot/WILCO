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
ok(legal.includes('export const PRIVACY_VERSION = "2026-09-29"'), "PRIVACY_VERSION moved to 2026-09-29 with the new section");
ok(legal.includes("Effective Date: May 22, 2026  |  Last Updated: September 29, 2026"), "the policy's Last Updated line says September 29, 2026");
const ATHLETE = "Your coach runs on Claude, an AI model made by Anthropic. To write your replies, programs and log entries, WILCO sends Anthropic your messages, workout logs, program, goals, injury notes and form-check video frames.";
const COACH = "WILCO runs on Claude, an AI model made by Anthropic. To write replies, programs and reports, WILCO sends Anthropic your athletes' messages, workout logs, programs, goals, injury notes and form-check video frames.";
ok(legal.includes(`export const AI_NOTICE_ATHLETE = "${ATHLETE}"`), "the athlete notice is exactly the two approved sentences");
ok(legal.includes(`export const AI_NOTICE_COACH = "${COACH}"`), "the coach notice is exactly the two approved sentences");
ok(legal.includes('export const AI_NOTICE_TITLE = "AI and Your Data"'), 'the policy heading is "AI and Your Data"');
ok(/function AiConsentBody/.test(legal), "a dedicated AI-consent body component exists (not folded into the Terms/Privacy renderer)");
{
  const body = legal.slice(legal.indexOf("function AiConsentBody"), legal.indexOf("// Whole years between"));
  ok(/AI_NOTICE_COACH : AI_NOTICE_ATHLETE/.test(body) && !/<ul|<li/.test(body), "the card body is only the notice (no bullet list, no extra sentences)");
}
ok(!/leadBlock/.test(legal) && !/leadBlock/.test(app), "leadBlock (the boxed block) is gone");
ok(!/[\u2014]/.test(legal.slice(legal.indexOf("export const AI_NOTICE_TITLE"), legal.indexOf("export const TERMS_TEXT"))), "no em-dashes in the notice copy");
{
  // The notice is the FIRST section of the policy text: after the two intro lines,
  // before "1. Information We Collect", and the renderer treats the title as a heading.
  const pol = legal.slice(legal.indexOf("export const PRIVACY_TEXT"), legal.indexOf("1. Information We Collect\n1.1"));
  const iTitle = pol.indexOf("${AI_NOTICE_TITLE}"), iBody = pol.indexOf("${AI_NOTICE_ATHLETE}");
  ok(iTitle > pol.indexOf("This Privacy Policy applies to the Platform") && iBody === iTitle + "${AI_NOTICE_TITLE}\n".length,
    "PRIVACY_TEXT carries the heading then the notice, after the intro lines and before section 1");
  ok(/t === AI_NOTICE_TITLE/.test(legal.slice(legal.indexOf("function LegalDocBody"))), "LegalDocBody renders the un-numbered AI title as a section heading");
  ok(legal.includes("\n1. Information We Collect\n1.1 Information You Provide Directly"), "existing sections were not renumbered");
}
ok(legal.includes("Anthropic"), "the provider is named: Anthropic");
// Only claim Anthropic doesn't train on WILCO's data if that sentence ALREADY
// exists in the Privacy text; it doesn't (checked 2026-09-29), so it is not invented.
ok(!/Anthropic does not use (it|your data|this data) to train/i.test(legal),
  "does NOT claim Anthropic excludes WILCO data from model training (not in PRIVACY_TEXT, so not invented here)");

console.log("\nConsentFlow — two steps, the AI notice is part of the Privacy step's policy text:");
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
  ok(/<LegalModal key="privacy"[^>]*text=\{PRIVACY_TEXT\}/.test(priv), "the privacy stage renders the policy text itself (which now opens with the AI notice)");
  ok(priv.includes('checkboxLabel="I agree to the Privacy Policy and allow WILCO to send my training data to Anthropic to power my coaching."'),
    "the one privacy checkbox label names the policy, Anthropic and the purpose, exactly");
  ok((cf.match(/checkboxLabel=/g) || []).length === 3, "signup has exactly three checkboxes at most (parental, terms, privacy), none added");
  const modal = legal.slice(legal.indexOf("export function LegalModal"), legal.indexOf("export function ConsentFlow"));
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
  ok(card.includes('kicker="ONE MORE THING"') && card.includes(`"AI and your athletes' data" : "AI and your data"`), "the card kicker and titles are as approved");
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
