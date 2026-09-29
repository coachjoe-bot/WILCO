// Block end dates never land in memory (T64 integration, verifier BUG-1 follow-up).
import { validateFact, blockEndRejects } from "../src/memory.js";
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const now = new Date("2026-09-29T12:00:00-04:00");
for (const s of ["Program block ends Oct 5", "Current block runs through October 11", "Block 2 wraps up Oct 11, 2026", "The program ends October 15th"])
  ok(blockEndRejects(s, now) === "block_end_date" && validateFact({ content: s, kind: "contextual" }).ok === false, `refused: ${s}`);
for (const s of ["Plans to run Day 1 on Aug 25 (swapped with Day 2)", "Season ends Oct 1", "Trains at 6am before class", "Gym closes at 9pm on Fridays", "Meet is on Nov 14", "Prefers dumbbells for pressing", "Watching: squat (pain) reported 2026-09-01 - a repeat within 2 weeks earns a program rec"])
  ok(blockEndRejects(s, now) === null, `allowed: ${s}`);
ok(validateFact({ content: "Meet is on Nov 14", kind: "contextual" }).ok === true, "an ordinary dated fact still saves");
console.log(`\nmemory-block-end: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
