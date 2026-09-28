import fs from "node:fs";
const R = JSON.parse(fs.readFileSync(process.argv[2] || "live-pain-pass-results.json", "utf8"));
const APP = /Drafted a program rec|one rough day|twice now|I couldn't draft that change/i;
const OFFER = /want me to|if you want|say the word|i can (adjust|swap|draft|change|put)|should i (adjust|swap|change|draft)|happy to (adjust|swap|draft|change)|let me know if you want|want a|do you want/i;
const COUNT = /\b(twice|three times|four times|five times|\d+ times|third time|second time|three sessions|two sessions|keeps? (flaring|coming back))\b/i;
const DATE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b/g;
const CLAIM = /\b(i'?ve|i have|i'?m) (swapped|swapping|pulled|pulling|changed|changing|removed|removing|replaced|replacing|updated|updating|adjusted|adjusting)\b/i;
const rows = [];
for (const r of R) {
  const t = r.tail.split("\n").slice(1).join("\n");
  const cut = t.search(/\n(Start Workout|🎬|Type naturally|→)\n?/);
  let body = (cut > 0 ? t.slice(0, cut) : t).replace(/^J\n/, "");
  const appLines = body.split("\n").filter((l) => APP.test(l));
  const joe = body.split("\n").filter((l) => !APP.test(l) && l.trim() !== "J").join("\n");
  const dates = (joe.match(DATE) || []).filter((d) => !r.ledger.includes(d.replace(/(\w{3})\w*\.?/, "$1")));
  const chk = { appBubble: appLines.length, recBar: r.recBar, offer: OFFER.test(joe), count: (joe.match(COUNT) || [null])[0], strayDates: dates, claim: CLAIM.test(joe), double: /\bdoubles?\b/i.test(joe), knee: /knee/i.test(joe), performed: r.hasPerformed };
  let pass;
  switch (r.name) {
    case "first": pass = chk.appBubble === 0 && !chk.recBar && chk.knee && !chk.count && !chk.strayDates.length && !chk.claim; break;
    case "worsening": pass = chk.appBubble === 0 && !chk.recBar && chk.offer && !chk.count && !chk.strayDates.length && !chk.claim; break;
    case "nextday": pass = chk.appBubble === 0 && !chk.recBar && !chk.offer && !chk.count && !chk.strayDates.length && !chk.claim; break;
    case "serious": pass = /Drafted a program rec for your knee/.test(body) && chk.recBar && chk.knee && !chk.claim && !chk.count; break;
    case "double": pass = !chk.double && chk.performed && !chk.claim; break;
  }
  rows.push({ name: r.name, run: r.run, pass, ...chk, joe: joe.replace(/\s+/g, " ").slice(0, 420) });
}
for (const x of rows) console.log(`${x.pass ? "PASS" : "FAIL"} ${x.name}#${x.run} app=${x.appBubble} rec=${x.recBar} offer=${x.offer} count=${x.count} dates=${x.strayDates} claim=${x.claim} double=${x.double} perf=${x.performed}\n   ${x.joe}`);
const by = {}; for (const x of rows) { by[x.name] = by[x.name] || [0, 0]; by[x.name][1]++; if (x.pass) by[x.name][0]++; }
console.log(JSON.stringify(by));
