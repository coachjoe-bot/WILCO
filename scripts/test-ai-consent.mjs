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
const check = (msg, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); ok(g === w, `${msg}\n      got:  ${g}\n      want: ${w}`); };

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

// ─── SERVER HALF: nothing reaches the AI for an athlete who never tapped Allow ──
// Behavioral: the real modules run against an in-memory stand-in for Supabase and
// the Anthropic API (global fetch is stubbed), so the cache rules, the chunking,
// the flag defaults and the fail-closed paths are exercised, not just grepped.
console.log("\napi — server-side AI permission (behavioral, stubbed fetch):");
{
  process.env.SUPABASE_URL = "http://sb.test";
  process.env.SUPABASE_SERVICE_KEY = "test-signing-key-not-a-real-secret";
  process.env.ANTHROPIC_KEY = "test-anthropic-key";
  process.env.CRON_SECRET = "test-cron-secret";
  const supa = await import("../api/_supa.js");
  const { hasAiConsent, aiConsentSet, mintSessionToken } = supa;

  const db = { consent: new Set(), due: [], patches: [], legalReads: [], anthropicCalls: 0, selfInvokes: [], legalFails: false, athletes: {}, rate: [] };
  const realFetch = globalThis.fetch;
  const J = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b) });
  const idsIn = (raw) => (raw.match(/"([^"]+)"/g) || []).map((x) => x.slice(1, -1));
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || "GET";
    const q = u.searchParams;
    if (u.hostname === "api.anthropic.com") { db.anthropicCalls++; return J({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 }, model: "claude-sonnet-5" }); }
    if (u.pathname === "/api/trigger-proof-feed") { const b = JSON.parse(opts.body); db.selfInvokes.push(b); return J({ ok: true, athlete: { athlete_id: b.athlete_id } }); }
    const table = u.pathname.split("/").pop();
    if (table === "legal_acceptances") {
      db.legalReads.push(String(url));
      if (db.legalFails) return J({ message: "boom" }, 500);
      const eq = q.get("athlete_id") || "";
      if (eq.startsWith("eq.")) { const id = decodeURIComponent(eq.slice(3)); return J(db.consent.has(id) ? [{ id: 1, athlete_id: id }] : []); }
      return J(idsIn(eq).filter((id) => db.consent.has(id)).map((id) => ({ athlete_id: id })));
    }
    if (table === "athletes") {
      if (method === "PATCH") { db.patches.push({ id: q.get("id"), body: JSON.parse(opts.body) }); return J([]); }
      if ((q.get("next_proof_due_at") || "").startsWith("lte.")) return J(db.due);
      if ((q.get("next_proof_due_at") || "") === "is.null") return J([]);
      const idq = q.get("id") || "";
      const ids = idq.startsWith("in.") ? idsIn(idq) : [idq.replace(/^eq\./, "")];
      return J(ids.filter((id) => db.athletes[id]).map((id) => db.athletes[id]));
    }
    if (table === "workouts") { const ids = idsIn(q.get("athlete_id") || ""); return J(ids.map((athlete_id) => ({ athlete_id }))); }
    if (table === "rate_limits") { if (method === "POST") { db.rate.push(1); return J({}, 201); } return J([]); }
    if (table === "coaches") return J([{ school_id: null }]);
    return J([]);
  };
  const run = async (handler, req) => {
    const out = { status: 200, body: null };
    const res = { setHeader() {}, status(n) { out.status = n; return res; }, json(b) { out.body = b; return res; }, end() { return res; } };
    await handler(req, res);
    return out;
  };

  // hasAiConsent
  check("no row means false", await hasAiConsent("ath-1"), false);
  check("a negative is never cached: the next call reads again", (await hasAiConsent("ath-1"), db.legalReads.length), 2);
  db.consent.add("ath-1");
  check("the moment the row exists the answer flips to true", await hasAiConsent("ath-1"), true);
  db.legalReads.length = 0; db.consent.delete("ath-1");
  check("a positive IS cached: warm instances skip the read", [await hasAiConsent("ath-1"), db.legalReads.length], [true, 0]);
  check("an empty id is never consented", await hasAiConsent(""), false);
  db.legalFails = true;
  let threw = false; try { await hasAiConsent("ath-fresh"); } catch { threw = true; }
  check("a failed read throws (fail closed), it does not answer 'allowed'", threw, true);
  db.legalFails = false;

  // aiConsentSet: one batched, chunked read
  db.legalReads.length = 0;
  const many = Array.from({ length: 250 }, (_, i) => `b-${String(i).padStart(3, "0")}`);
  ["b-000", "b-120", "b-249"].forEach((id) => db.consent.add(id));
  const got = await aiConsentSet(many);
  check("250 ids -> 3 requests, none over 100 ids", [db.legalReads.length, db.legalReads.every((u) => idsIn(decodeURIComponent(u)).length <= 100)], [3, true]);
  check("the set holds exactly the consenting ids", [...got].sort(), ["b-000", "b-120", "b-249"]);
  db.legalReads.length = 0;
  await aiConsentSet(many);
  check("second pass: only the ids not already known-yes are re-read", db.legalReads.reduce((n, u) => n + idsIn(decodeURIComponent(u)).length, 0), 247);

  // askClaudeServer refuses on its own
  let refused = null;
  try { await supa.askClaudeServer({ system: "s", user: "u", attribution: { role: "athlete", athlete_id: "ath-none" } }); } catch (e) { refused = e; }
  check("askClaudeServer for an athlete with no row throws 403 and never calls Anthropic", [refused && refused.status, db.anthropicCalls], [403, 0]);
  const txt = await supa.askClaudeServer({ system: "s", user: "u", attribution: { role: "athlete", athlete_id: "b-000" } });
  check("askClaudeServer for a consenting athlete goes through", [txt, db.anthropicCalls], ["ok", 1]);

  // api/claude.js
  const { default: claudeHandler } = await import("../api/claude.js");
  const callClaude = (role, id) => run(claudeHandler, { method: "POST", headers: {}, body: { auth: { role, id, token: mintSessionToken(role, id) }, messages: [{ role: "user", content: "hi" }], feature: "joebot_chat" } });
  delete process.env.AI_CONSENT_ENFORCE;
  db.anthropicCalls = 0;
  let r = await callClaude("athlete", "no-row-athlete");
  check("AI_CONSENT_ENFORCE unset: an athlete with no row still gets through (old bundles keep working)", [r.status, db.anthropicCalls], [200, 1]);
  process.env.AI_CONSENT_ENFORCE = "on";
  db.anthropicCalls = 0;
  r = await callClaude("athlete", "no-row-athlete");
  check("AI_CONSENT_ENFORCE=on: no row -> 403 'AI permission required', Anthropic never called", [r.status, r.body && r.body.error, db.anthropicCalls], [403, "AI permission required", 0]);
  r = await callClaude("athlete", "b-120");
  check("AI_CONSENT_ENFORCE=on: an athlete with the row gets through", [r.status, db.anthropicCalls], [200, 1]);
  db.legalFails = true;
  r = await callClaude("athlete", "unread-athlete");
  check("AI_CONSENT_ENFORCE=on and the read fails: refused, not allowed", r.status >= 400, true);
  db.legalFails = false;
  db.anthropicCalls = 0;
  r = await callClaude("coach", "some-coach");
  check("coaches are not checked server-side (their permission lives on the device)", [r.status, db.anthropicCalls], [200, 1]);
  process.env.AI_CONSENT_ENFORCE = "off";
  db.anthropicCalls = 0;
  r = await callClaude("athlete", "no-row-athlete");
  check("AI_CONSENT_ENFORCE=off behaves like unset", [r.status, db.anthropicCalls], [200, 1]);
  delete process.env.AI_CONSENT_ENFORCE;

  // api/trigger-proof-feed.js
  const { default: proofHandler } = await import("../api/trigger-proof-feed.js");
  const cron = (body) => run(proofHandler, { method: "POST", headers: { authorization: "Bearer test-cron-secret" }, body });
  db.consent = new Set(["due-0007", "due-0150", "due-0299"]);
  db.due = Array.from({ length: 300 }, (_, i) => ({ id: `due-${String(i).padStart(4, "0")}`, coach_id: null, proof_enabled: true, last_proof_run_date: null }));
  for (const k of Object.keys(db.athletes)) delete db.athletes[k];
  // (the positive cache from earlier sections must not hide the point of this section)
  db.legalReads.length = 0; db.patches.length = 0; db.selfInvokes.length = 0;
  r = await cron({});
  const invoked = db.selfInvokes.map((b) => b.athlete_id).sort();
  check("dispatcher: only consenting athletes are dispatched", invoked, ["due-0007", "due-0150", "due-0299"]);
  check("dispatcher: the permission read is batched and chunked (3 requests for 300 ids, max 100 ids each)",
    [db.legalReads.length, db.legalReads.every((u) => idsIn(decodeURIComponent(u)).length <= 100)], [3, true]);
  const bumped = db.patches.filter((x) => x.body && x.body.next_proof_due_at);
  check("dispatcher: each skipped athlete's next slot is pushed out (297 PATCHes, about a day)",
    [bumped.length, bumped.every((x) => { const d = new Date(x.body.next_proof_due_at) - Date.now(); return d > 20 * 3600e3 && d < 28 * 3600e3; })], [297, true]);
  check("dispatcher: skipped athletes are reported with a reason", (r.body.skipped || []).filter((x) => x.reason === "no-ai-permission").length, 297);

  db.consent = new Set();
  db.legalFails = true;
  db.legalReads.length = 0; db.patches.length = 0; db.selfInvokes.length = 0;
  // a fresh id set so the positive cache cannot answer for us
  db.due = Array.from({ length: 5 }, (_, i) => ({ id: `fresh-${i}`, coach_id: null, proof_enabled: true, last_proof_run_date: null }));
  r = await cron({});
  check("dispatcher: if the permission read fails, nobody is dispatched and no slot is touched",
    [db.selfInvokes.length, db.patches.length], [0, 0]);
  db.legalFails = false;

  // single-athlete child + run-now
  db.athletes["solo-1"] = { id: "solo-1", name: "Solo", proof_enabled: true, last_proof_run_date: null };
  db.selfInvokes.length = 0; db.anthropicCalls = 0;
  r = await cron({ athlete_id: "solo-1" });
  check("child (athlete_id): no row -> skipped with a reason, no digest generated", [r.body.ok, r.body.skipped, r.body.reason, db.anthropicCalls], [false, true, "no-ai-permission", 0]);
  r = await run(proofHandler, { method: "POST", headers: {}, body: { run_now: true, auth: { role: "athlete", id: "solo-1", token: mintSessionToken("athlete", "solo-1") } } });
  check("run-now: no row -> polite refusal, nothing generated", [r.body.ok, /Allow AI/.test(r.body.reason || ""), db.anthropicCalls], [false, true, 0]);
  r = await cron({ dry_run: true, sample_athlete_ids: ["solo-1"] });
  check("dry-run sampler: no row -> reported as skipped, nothing generated", [r.body.samples && r.body.samples[0] && r.body.samples[0].skipped, db.anthropicCalls], [true, 0]);

  globalThis.fetch = realFetch;
}

console.log("\napi — server-side AI permission (source contract):");
{
  const supaSrc = readFileSync(new URL("../api/_supa.js", import.meta.url), "utf8");
  const claudeSrc = readFileSync(new URL("../api/claude.js", import.meta.url), "utf8");
  const proofSrc = readFileSync(new URL("../api/trigger-proof-feed.js", import.meta.url), "utf8");
  ok(/export async function hasAiConsent\(athleteId\)/.test(supaSrc) && /document=eq\.ai_processing/.test(supaSrc), "_supa.js exports hasAiConsent reading legal_acceptances document=ai_processing");
  ok(/if \(rows\.length\) \{ aiConsentRemember\(id\); return true; \}\s*return false;/.test(supaSrc), "only a positive is remembered; the negative branch returns without caching");
  ok(/export async function aiConsentSet\(athleteIds, \{ chunk = 100 \}/.test(supaSrc), "the batched form chunks at 100 ids");
  ok(/attribution\.athlete_id && !\(await hasAiConsent\(attribution\.athlete_id\)\)/.test(supaSrc), "askClaudeServer refuses athlete-attributed work without the row (no flag)");
  ok(/process\.env\.AI_CONSENT_ENFORCE \|\| ""\)\.toLowerCase\(\) === "on"/.test(claudeSrc) && /caller\.role === "athlete"/.test(claudeSrc), "claude.js enforces only for athletes, only when AI_CONSENT_ENFORCE is on (default off)");
  ok(/httpErr\(403, "AI permission required"\)/.test(claudeSrc), "claude.js refuses with 403 AI permission required");
  ok(/device only/.test(claudeSrc), "claude.js says why coaches are not checked server-side");
  ok(!/AI_CONSENT_ENFORCE|process\.env\.[A-Z_]*CONSENT/.test(proofSrc), "the scheduled proof engine has no env flag for this: it always skips");
  ok((proofSrc.match(/hasAiConsent\(/g) || []).length >= 2 && (proofSrc.match(/aiConsentSet\(/g) || []).length >= 3,
    "proof engine checks run-now + single-athlete via hasAiConsent and the dispatcher, sampler and coach roster via aiConsentSet");
  // Every server path that sends athlete data to the AI provider. If a new one appears
  // this list must grow and the path must be gated: the only two hosts are below.
  const apiFiles = ["claude.js", "_supa.js", "_proof.js", "trigger-proof-feed.js", "send-weekly-report.js", "notify-program-changes.js", "push.js", "data.js", "identity.js", "coach-analytics.js"];
  const hitting = apiFiles.filter((f) => /api\.anthropic\.com/.test(readFileSync(new URL(`../api/${f}`, import.meta.url), "utf8")));
  ok(hitting.sort().join(",") === "_supa.js,claude.js", "only api/claude.js and askClaudeServer (_supa.js) call the AI provider; send-weekly-report, notify-program-changes and push do not");
}

console.log(`\n${fail === 0 ? `All ${pass} checks green.` : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
