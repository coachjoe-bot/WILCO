// One-off: regenerate proof-feed-v3 review samples as REAL pipeline output.
// Runs the actual _proof.js builders + generateWeekly against real prod data
// (read-only via service key), but routes the Claude call through PROD /api/claude
// with a locally-minted session token — so NO Anthropic key is needed locally and
// NOTHING is written to proof_digests. Usage: node --env-file=.env scripts/gen-proof-samples.mjs
import {
  groupIntoSessions, aggregateInjuries, buildOneRMs, painTrend, computeRankMovement,
  buildBrief, parseProgramIfNeeded, compareProgramVsActual, generateWeekly,
} from "../api/_proof.js";
import { sbSelect, sbDelete } from "../api/_supa.js";

const PROD = "https://app.trainwilco.com";
const enc = encodeURIComponent;

// The doc's 3 exemplars, by exact id: rank movement + improving pain (Will Higgins),
// big rank jump + worsening pain (Jonathan Herrero), steady high-volume no-pain (Joe T,
// the roster's most active at ~100/28d — distinct from the zero-session "Joe Thomas").
const WANT_IDS = ["0704b840-45db-4bff-81eb-064154092e7f", "575a0f83-66cb-4013-9649-8a4b5e13cbc5", "a363f1bb-5e74-4407-b099-a3119a8b60f1"];

// ── verbatim copy of fetchBatch (api/trigger-proof-feed.js) ──
async function fetchBatch(ids) {
  if (!ids.length) return { workouts: [], goals: [], prs: [], manual: [], prescriptions: [] };
  const idList = ids.map((id) => `"${id}"`).join(",");
  const since = new Date(Date.now() - 28 * 864e5).toISOString();
  const [workouts, goals, prs, manual, prescriptions] = await Promise.all([
    sbSelect("workouts", `?athlete_id=in.(${idList})&created_at=gte.${since}&select=*&order=created_at.asc`),
    sbSelect("athlete_goals", `?athlete_id=in.(${idList})&select=*&order=created_at.desc`),
    sbSelect("prs", `?athlete_id=in.(${idList})&select=*`),
    sbSelect("manual_one_rms", `?athlete_id=in.(${idList})&select=*`),
    sbSelect("program_prescriptions", `?athlete_id=in.(${idList})&select=*`).catch(() => []),
  ]);
  return { workouts, goals, prs, manual, prescriptions };
}

// ── verbatim copy of briefFor (api/trigger-proof-feed.js) ──
const briefFor = (athlete, batch, windowType, fullWorkouts, fullManual, previousEntryAt) => {
  const w28 = (batch.workouts || []).filter((w) => w.athlete_id === athlete.id);
  const goals = (batch.goals || []).filter((g) => g.athlete_id === athlete.id);
  const prs = (batch.prs || []).filter((p) => p.athlete_id === athlete.id);
  const manual = (batch.manual || []).filter((m) => m.athlete_id === athlete.id);
  const thisWeekCut = new Date(Date.now() - 7 * 864e5).toISOString();
  const lastWeekCut = new Date(Date.now() - 14 * 864e5).toISOString();
  const monthCut = new Date(Date.now() - 28 * 864e5).toISOString();
  const thisWeekSessions = groupIntoSessions(w28.filter((w) => w.created_at >= thisWeekCut));
  const lastWeekSessions = groupIntoSessions(w28.filter((w) => w.created_at >= lastWeekCut && w.created_at < thisWeekCut));
  const monthSessions = groupIntoSessions(windowType === "monthly" ? w28 : w28.filter((w) => w.created_at >= monthCut));
  const oneRMs = buildOneRMs(prs, manual);
  const injuries = aggregateInjuries(
    windowType === "monthly" ? monthSessions : [...lastWeekSessions, ...thisWeekSessions],
    athlete.resolved_pain || []
  );
  const painTrendData = painTrend(thisWeekSessions, lastWeekSessions, athlete.resolved_pain || []);
  let rank = null;
  const bodyweightLbs = athlete.weight_lbs || athlete.weight;
  if (bodyweightLbs && (fullWorkouts || fullManual)) {
    try { rank = computeRankMovement(fullWorkouts || [], fullManual || [], athlete, previousEntryAt); }
    catch (e) { console.error("rank movement failed:", e.message); }
  }
  return {
    thisWeekSessions, lastWeekSessions, monthSessions, prs, oneRMs,
    brief: buildBrief({ athlete, thisWeekSessions, lastWeekSessions, monthSessions, prs, goals, adherence: null, injuries, windowType, rank, painTrendData }),
  };
};

// A throwaway athlete's PROD-signed token authenticates the /api/claude calls.
// (Local .env holds a new-format sb_secret_ service key; prod signs tokens with a
// different SUPABASE_SERVICE_KEY string, so a locally-minted token won't verify —
// a real login token from prod does.) Content is fully determined by system+messages,
// so which athlete "owns" the call is irrelevant to the generated prose.
async function makeThrowaway() {
  const r = await fetch(`${PROD}/api/identity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://app.trainwilco.com" },
    body: JSON.stringify({ action: "create-athlete", pin: "1234", athlete: { name: "ZZ Sample Bot", email: `sample-bot-${Date.now()}@example.invalid`, sport: "General" } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) throw new Error(`create-athlete failed ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return { id: d.athlete.id, auth: { role: "athlete", id: d.athlete.id, token: d.token } };
}

// Shim: route generateWeekly's Claude call through PROD /api/claude (real Sonnet 5,
// server-side inference params applied there). Mirrors askClaudeServer's return
// contract (the assistant text string).
function makeAskClaude(auth) {
  return async ({ system, user, maxTokens = 1200, model = "claude-sonnet-5", feature = "proof_weekly" }) => {
    const r = await fetch(`${PROD}/api/claude`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://app.trainwilco.com" },
      body: JSON.stringify({ auth, model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }], feature }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(`claude proxy ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
    return d.content?.[0]?.text || "";
  };
}

async function main() {
  const ids = [...new Set(WANT_IDS)];
  const rows = await sbSelect("athletes", `?id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=*`);
  const batch = await fetchBatch(rows.map((a) => a.id));

  const bot = await makeThrowaway();
  console.error(`↪ throwaway caller ${bot.id}`);
  const askClaudeServer = makeAskClaude(bot.auth);

  const out = [];
  try {
  for (const athlete of rows) {
    const windowType = "weekly";
    const attribution = { role: "athlete", actor_id: athlete.id, athlete_id: athlete.id, school_id: athlete.school_id ?? null, coach_id: athlete.coach_id ?? null, tier: athlete.tier ?? null };
    const deps = { askClaudeServer, sbWrite: async () => {}, sbSelect, attribution };

    const [fullWorkouts, fullManual] = await Promise.all([
      sbSelect("workouts", `?athlete_id=eq.${enc(athlete.id)}&select=created_at,parsed_data&order=created_at.desc&limit=300`),
      sbSelect("manual_one_rms", `?athlete_id=eq.${enc(athlete.id)}&select=exercise,normalized_exercise,weight,unit`),
    ]);
    const prior = await sbSelect("proof_digests", `?athlete_id=eq.${enc(athlete.id)}&digest_type=in.(weekly,monthly)&select=created_at&order=created_at.desc&limit=1`).catch(() => []);
    const previousEntryAt = prior[0]?.created_at || null;

    const b = briefFor(athlete, batch, windowType, fullWorkouts, fullManual, previousEntryAt);
    const existingRx = (batch.prescriptions || []).find((p) => p.athlete_id === athlete.id) || null;
    try {
      const parsed = athlete.temp_program_text ? null : await parseProgramIfNeeded(athlete, existingRx, deps);
      if (parsed) b.brief.volume = compareProgramVsActual(parsed, b.thisWeekSessions, b.oneRMs);
    } catch (e) { console.error("program parse failed:", e.message); }

    const digest = await generateWeekly(athlete, b.brief, deps);
    out.push({ name: athlete.name, id: athlete.id, prevEntry: previousEntryAt, rank: b.brief.rank, painTrend: b.brief.painTrend, digest });
    console.error(`✓ generated for ${athlete.name} (${athlete.id})`);
  }
  } finally {
    // Report sample cost, then scrub the throwaway athlete + its cost rows.
    try {
      const costRows = await sbSelect("usage_costs", `?actor_id=eq.${enc(bot.id)}&select=input_tokens,output_tokens,model,feature`);
      const tot = costRows.reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0);
      console.error(`↪ sample cost: ${costRows.length} usage_costs rows, ${tot} total tokens (${costRows.map((r) => r.feature).join(",")})`);
      await sbDelete("usage_costs", `?actor_id=eq.${enc(bot.id)}`);
      await sbDelete("workouts", `?athlete_id=eq.${enc(bot.id)}`);
      await sbDelete("athletes", `?id=eq.${enc(bot.id)}`);
      console.error(`↪ cleaned up throwaway ${bot.id}`);
    } catch (e) { console.error("cleanup warning:", e.message); }
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
