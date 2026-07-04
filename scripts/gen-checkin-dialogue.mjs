// One-off: sample the POST-DIGEST check-in dialogue (ProofChatModal) as REAL output.
// Replays the exact react() prompt from src/App.jsx (claude-sonnet-5, 170 tok,
// feature joebot_chat) through PROD /api/claude with a throwaway caller token, using
// Will Higgins's real generated digest + question bank and authored athlete answers.
// Usage: node --env-file=.env scripts/gen-checkin-dialogue.mjs
import { sbSelect, sbDelete } from "../api/_supa.js";
import { readFileSync } from "node:fs";

const PROD = "https://app.trainwilco.com";
const enc = encodeURIComponent;
const SAMPLES = "/private/tmp/claude-501/-Users-willhiggins/a689746a-0b6c-47e4-8d83-c189bf0d88a6/scratchpad/samples.json";

// Authored, realistic athlete answers for Will's 4 top questions (weight, injury,
// injury_apply, recovery) — varied so Joe's "does this warrant a reaction?" logic shows.
const ANSWERS = [
  "Still 165, maybe 164 first thing in the morning",
  "It's lingering. Not sharp anymore but I still feel it on heavy bench",
  "Yeah let's apply it, I'm good with floor press for a couple weeks",
  "Flat this week honestly, newborn's got my sleep wrecked",
];

async function makeThrowaway() {
  const r = await fetch(`${PROD}/api/identity`, {
    method: "POST", headers: { "Content-Type": "application/json", "Origin": "https://app.trainwilco.com" },
    body: JSON.stringify({ action: "create-athlete", pin: "1234", athlete: { name: "ZZ Dialogue Bot", email: `dlg-bot-${Date.now()}@example.invalid`, sport: "General" } }),
  });
  const d = await r.json();
  if (!r.ok || !d.token) throw new Error(`create-athlete ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return { id: d.athlete.id, auth: { role: "athlete", id: d.athlete.id, token: d.token } };
}

// Mirror App.jsx askClaude(system, user, 170, [], "claude-sonnet-5", "joebot_chat").
function makeAsk(auth) {
  return async (system, user) => {
    const r = await fetch(`${PROD}/api/claude`, {
      method: "POST", headers: { "Content-Type": "application/json", "Origin": "https://app.trainwilco.com" },
      body: JSON.stringify({ auth, model: "claude-sonnet-5", max_tokens: 170, system, messages: [{ role: "user", content: user }], feature: "joebot_chat" }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(`claude ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
    return (d.content?.[0]?.text || "").trim();
  };
}

async function main() {
  const out = JSON.parse(readFileSync(SAMPLES, "utf8"));
  const will = out.find((o) => o.name === "Will Higgins");
  const c = will.digest.contentJson;
  const isMonthly = false;
  const NONE = "[[NONE]]";
  const topQuestions = (c.questions || []).filter((q) => !q.deeper);
  const deeperQuestions = (c.questions || []).filter((q) => q.deeper);

  const bot = await makeThrowaway();
  const ask = makeAsk(bot.auth);
  const transcript = [];
  transcript.push({ who: "JOE (opens with the digest)", text: c.intro + " …[full digest from Sample 1]…" });

  try {
    // Joe posts the first top question verbatim (scripted, no model call).
    transcript.push({ who: "JOE", text: topQuestions[0].text });
    const answered = [];

    for (let i = 0; i < topQuestions.length; i++) {
      const q = topQuestions[i];
      const msg = ANSWERS[i] ?? "sounds good";
      transcript.push({ who: "WILL", text: msg });
      answered.push({ kind: q.kind, q: q.text, a: msg });

      const hasNext = i + 1 < topQuestions.length;
      const nextQ = hasNext ? topQuestions[i + 1] : null;
      const willOfferDeeper = !hasNext && deeperQuestions.length > 0;
      const soFar = answered.map((a) => `Q: ${a.q}\nA: ${a.a}`).join("\n");

      const base = `You are Coach Joe Thomas running an athlete's ${isMonthly ? "monthly" : "weekly"} check-in — a real strength coach texting them back. Direct, specific, warm, no fluff, no lists, no emoji spam. The athlete just answered your question. First decide whether their answer actually warrants a genuine response: a real detail, a concern, effort, or something worth reacting to warrants one; a thin/low-effort/empty reply ("idk", "nothing", "fine", "n/a", a shrug) does NOT — don't force it.`;
      const system = hasNext
        ? `${base} If it warrants a response: reply in 2-4 sentences that (1) react to what they actually said, referencing a real detail, and (2) then lead into the next thing you want to know: "${nextQ.text}" — keep that question's intent but phrase it as a natural follow-up. If it does NOT warrant a response: reply with ONLY the next question, phrased naturally ("${nextQ.text}"), no forced reaction. Ask only that one question either way. Talk like a text message.`
        : `${base} This is the last question, so do NOT ask anything new. If it warrants a response: reply in 1-3 sentences reacting to what they said, in your voice, closing the loop. If it does NOT warrant a response: reply with EXACTLY "${NONE}" and nothing else. Talk like a text message.`;

      let reaction = await ask(system, `Digest flags: ${JSON.stringify(c.flags || {})}\n\nCheck-in so far:\n${soFar}\n\nThe question you just asked: "${q.text}"\nTheir answer: "${msg}"`);
      if (reaction === NONE || reaction.includes(NONE)) reaction = "";
      if (hasNext) {
        transcript.push({ who: "JOE", text: reaction || nextQ.text });
      } else {
        if (reaction) transcript.push({ who: "JOE", text: reaction });
        if (willOfferDeeper) transcript.push({ who: "JOE", text: "That's the short version. Want to go deeper, or wrap it here?" });
      }
    }
  } finally {
    try {
      const cost = await sbSelect("usage_costs", `?actor_id=eq.${enc(bot.id)}&select=input_tokens,output_tokens`);
      const tot = cost.reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0);
      console.error(`↪ ${cost.length} calls, ${tot} tokens; cleaning up ${bot.id}`);
      await sbDelete("usage_costs", `?actor_id=eq.${enc(bot.id)}`);
      await sbDelete("workouts", `?athlete_id=eq.${enc(bot.id)}`);
      await sbDelete("athletes", `?id=eq.${enc(bot.id)}`);
    } catch (e) { console.error("cleanup warn:", e.message); }
  }
  console.log(JSON.stringify(transcript, null, 2));
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
