// Invariants for scripts/live-pain-pass-s2b.mjs output (T64 S2b).
//   node scripts/live-pain-pass-s2b-analyze.mjs <results.json>
import fs from "node:fs";
const res = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const COUNT = /\b(twice|three times|\d+ times|second time|third time|\d+ mentions|again and again)\b/i;
const PEC = /\b(pec|pecs|chest)\b/i;
const OFFER = /\b(want me to|if you want|say the word|happy to|i can (adjust|swap|change|draft|pull|stage|back)|we could|should i)\b/i;
const out = {};
for (const r of res) {
  const reply = (r.tail || "").split(/\n(?:🎬|↑)\n/)[0];
  let pass, why = [];
  if (r.name === "trajfree") {
    pass = !PEC.test(reply) && !r.recRows.length;
    if (PEC.test(reply)) why.push("mentioned the pec");
  } else if (r.name === "trajask") {
    const dir = /right (way|direction)|improv|better|trending|heading|easing|getting there|settl|calm/i.test(reply);
    pass = PEC.test(reply) && dir && !COUNT.test(reply) && !r.recRows.length;
    if (!dir) why.push("no direction"); if (COUNT.test(reply)) why.push("count: " + reply.match(COUNT)[0]);
    if (!/Headed the right way/.test(r.ledger)) why.push("ledger line lacks direction");
  } else if (r.name === "worse2") {
    const offers = (reply.match(new RegExp(OFFER.source, "gi")) || []).length;
    pass = offers >= 1 && !r.recRows.length && !r.recBar && /offer_change_once/.test(r.ledger);
    if (!offers) why.push("no offer"); if (r.recRows.length || r.recBar) why.push("rec staged");
    if (!/offer_change_once/.test(r.ledger)) why.push("verdict not offer");
    if (COUNT.test(reply)) why.push("count: " + reply.match(COUNT)[0]);
  } else if (r.name === "sheet") {
    const painTalk = /\b(pec|chest)\b[^.]*\b(strain|linger|pain|hurt|careful|easy|protect|sore|injur)|\b(strain|linger|pain|hurt|careful|protect|injur)[^.]*\b(pec|chest)\b/i;
    pass = !r.err && !!r.notes && !painTalk.test(r.notes) && r.promptHasCurrentPain && r.promptInjuryBackground;
    if (r.err) why.push(r.err); if (painTalk.test(r.notes || "")) why.push("note mentions pec pain");
    if (painTalk.test(r.rawNote || "")) why.push("(model wrote pec pain; code guard removed it)");
  }
  (out[r.name] = out[r.name] || []).push({ run: r.run, pass, why: why.join("; "), reply: (r.notes ?? reply).slice(0, 300) });
}
for (const [k, v] of Object.entries(out)) {
  console.log(`\n## ${k}: ${v.filter((x) => x.pass).length}/${v.length}`);
  for (const x of v) console.log(`  #${x.run} ${x.pass ? "PASS" : "FAIL"} ${x.why}\n     ${JSON.stringify(x.reply)}`);
}
