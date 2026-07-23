// Boot-layer regression suite — the guard rail for src/boot.js.
// Run with: node scripts/test-boot.mjs
//
// Three things are at stake here and each one fails LOUDLY in the athlete's face:
//   • a false "new version ready" nags everyone on the current build into reloading,
//     and a missed one leaves them on a build whose chunks 404 (the 07-21 coach crash)
//   • a snapshot that's too big blows the localStorage quota — which takes down every
//     other localStorage writer in the app, not just the snapshot
//   • an offline queue that drops (or double-replays) a message loses / duplicates a
//     logged workout, which is the one thing this app must never do
// So the negative cases get more coverage than the happy ones.

// Minimal localStorage stand-in with the index accessors pruneSnapshots needs.
const store = new Map();
const makeStore = () => ({
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
});
globalThis.localStorage = makeStore();

const B = await import("../src/boot.js");

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}`); } };
const reset = () => store.clear();

// ─── 1. BUILD FRESHNESS ──────────────────────────────────────────────────────

// A tiny document stand-in: querySelectorAll returns nodes with getAttribute.
const fakeDoc = (tags) => ({
  querySelectorAll: () => tags.map(([attr, val]) => ({ getAttribute: (a) => (a === attr ? val : null) })),
});

const paths = B.runningAssetPaths(
  fakeDoc([["src", "/assets/index-AAA.js"], ["href", "/assets/style-BBB.css"], ["src", "https://js.stripe.com/v3"]]),
  "https://app.trainwilco.com/assets/index-AAA.js"
);
check("collects script + stylesheet asset paths", paths.has("/assets/index-AAA.js") && paths.has("/assets/style-BBB.css"));
check("ignores third-party scripts", !paths.has("/v3"));
check("module URL alone is enough with no DOM", B.runningAssetPaths(null, "/assets/index-CCC.js").has("/assets/index-CCC.js"));
check("non-/assets/ paths are ignored", !B.runningAssetPaths(null, "/main.jsx").size);

const LIVE = { assets: ["/assets/index-AAA.js", "/assets/style-BBB.css", "/assets/vendor-react-ZZZ.js"] };
check("current build is not stale", B.isStaleBuild(new Set(["/assets/index-AAA.js"]), LIVE) === false);
check("missing entry chunk IS stale", B.isStaleBuild(new Set(["/assets/index-OLD.js"]), LIVE) === true);
check("one missing of several is stale", B.isStaleBuild(new Set(["/assets/index-AAA.js", "/assets/style-OLD.css"]), LIVE) === true);

// Every uncertain input must answer "no update" — a false positive nags the entire
// installed base into a reload loop, which is worse than the bug this feature fixes.
check("null manifest → not stale", B.isStaleBuild(new Set(["/assets/index-AAA.js"]), null) === false);
check("manifest with no assets key → not stale", B.isStaleBuild(new Set(["/assets/index-AAA.js"]), {}) === false);
check("EMPTY manifest asset list → not stale", B.isStaleBuild(new Set(["/assets/index-AAA.js"]), { assets: [] }) === false);
check("assets not an array → not stale", B.isStaleBuild(new Set(["/assets/index-AAA.js"]), { assets: "nope" }) === false);
check("no running assets identified (dev server) → not stale", B.isStaleBuild(new Set(), LIVE) === false);
check("accepts a plain array of running assets", B.isStaleBuild(["/assets/index-OLD.js"], LIVE) === true);

// ─── 2. SNAPSHOT ─────────────────────────────────────────────────────────────

const ATH = "ath-1";
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: "w" + i, created_at: "2026-07-2" + (i % 9), parsed_data: { exercises: [] } }));
const SNAP = {
  athlete: { id: ATH, name: "Marcus", pin: "1234", total_sessions_logged: 41 },
  workoutHistory: rows(100),
  goals: [{ goal_text: "squat 405" }],
  context: "knee rehab",
  digest: { id: "d1", is_read: false },
};

reset();
B.saveSnapshot(ATH, SNAP);
const got = B.loadSnapshot(ATH);
check("snapshot round trips", !!got && got.athlete.name === "Marcus");
check("snapshot caps workouts at SNAPSHOT_ROWS", got.workouts.length === B.SNAPSHOT_ROWS);
check("snapshot keeps the newest rows (head of the list)", got.workouts[0].id === "w0");
check("snapshot carries goals + context + digest", got.goals.length === 1 && got.context === "knee rehab" && got.digest.id === "d1");
// The PIN has its own store with its own trust window and its own wipe-on-logout.
// A second copy here would outlive that, which is how a credential leaks.
check("snapshot NEVER stores the PIN", got.athlete.pin === undefined && !JSON.stringify(store.get(B.snapshotKey(ATH))).includes("1234"));

check("snapshot is scoped per athlete", B.loadSnapshot("someone-else") === null);
reset();
check("no snapshot → null, not a throw", B.loadSnapshot(ATH) === null);

// Age + version rejection: a stale or foreign-shaped blob must be ignored, never painted.
reset();
store.set(B.snapshotKey(ATH), JSON.stringify({ ...B.buildSnapshot(SNAP), at: Date.now() - (B.SNAPSHOT_MAX_AGE_MS + 1000) }));
check("expired snapshot is not used", B.loadSnapshot(ATH) === null);
reset();
store.set(B.snapshotKey(ATH), JSON.stringify({ ...B.buildSnapshot(SNAP), at: Date.now() - 1000, v: 99 }));
check("future/foreign snapshot version is not used", B.loadSnapshot(ATH) === null);
reset();
store.set(B.snapshotKey(ATH), "{not json");
check("corrupt snapshot is not used", B.loadSnapshot(ATH) === null);

reset();
B.saveSnapshot("a", SNAP); B.saveSnapshot("b", SNAP); B.saveSnapshot("c", SNAP);
B.pruneSnapshots("b");
check("prune keeps the named athlete", B.loadSnapshot("b") !== null);
check("prune drops the others", B.loadSnapshot("a") === null && B.loadSnapshot("c") === null);

reset();
B.saveSnapshot(ATH, SNAP);
B.clearSnapshot(ATH);
check("clear (logout) removes the snapshot", B.loadSnapshot(ATH) === null);

// Quota: the retry path must actually free space and land the write. A shared team
// phone with several athletes' snapshots is the realistic way to hit this.
{
  const quotaStore = {
    map: new Map(),
    fullUntilPruned: true,
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
    setItem(k, v) {
      if (this.fullUntilPruned && this.map.size > 1) { const e = new Error("QuotaExceededError"); throw e; }
      this.map.set(k, String(v));
    },
    removeItem(k) { this.map.delete(k); },
    key(i) { return [...this.map.keys()][i] ?? null; },
    get length() { return this.map.size; },
  };
  quotaStore.map.set(B.snapshotKey("old-a"), "x");
  quotaStore.map.set(B.snapshotKey("old-b"), "y");
  const ok = B.saveSnapshot(ATH, SNAP, quotaStore);
  check("quota failure prunes other athletes and retries", ok === true && quotaStore.map.has(B.snapshotKey(ATH)));
}
{
  // A store that ALWAYS throws must return false, never bubble — the caller is a
  // best-effort effect and an exception there would break the render it runs in.
  const deadStore = { getItem() { throw new Error("nope"); }, setItem() { throw new Error("nope"); }, removeItem() {}, key() { return null; }, length: 0 };
  check("hostile storage never throws out of saveSnapshot", B.saveSnapshot(ATH, SNAP, deadStore) === false);
  check("hostile storage never throws out of loadSnapshot", B.loadSnapshot(ATH, deadStore) === null);
}

// ─── 2b. GREETING PARITY ─────────────────────────────────────────────────────
// The snapshot path and the network path must produce identical text from identical
// inputs — otherwise a warm reopen visibly rewrites Joe's greeting a second later.
const G = (o) => B.buildGreeting({ name: "Marcus", isFree: false, hasLog: true, dAgo: 1, summary: "Last session (Jul 21): Squat 315x3.", ...o });
check("same inputs → same greeting", G({}) === G({}));
check("no log → first-workout welcome", G({ hasLog: false }).includes("Tell me about your first workout"));
check("free tier with history → starting-fresh line", G({ isFree: true }).includes("Free tier doesn't store your history"));
check("free tier with NO history → plain welcome", G({ isFree: true, hasLog: false }).includes("Welcome to WILCO"));
check("7+ days → the week callout", G({ dAgo: 9 }).includes("That's a week"));
check("4-6 days → workout 100 line", G({ dAgo: 5 }).includes("workout 100"));
check("2-3 days → back at it", G({ dAgo: 3 }).startsWith("Back at it"));
check("recent with summary → summary line", G({ dAgo: 0 }).includes("Squat 315x3"));
check("recent with no summary → plain prompt", G({ dAgo: 0, summary: "" }) === "What's up, Marcus. What did you get after today?");
check("day count is rendered, not rounded away", G({ dAgo: 12 }).includes("12 days"));

// ─── 3. OFFLINE OUTBOX ───────────────────────────────────────────────────────

reset();
B.queueOutbox(ATH, "Bench 3x5 225");
check("queued message is readable", B.readOutbox(ATH).length === 1 && B.readOutbox(ATH)[0].text === "Bench 3x5 225");
check("plain message is not marked pure", B.readOutbox(ATH)[0].pure === false);
// A double-tap on SEND with no signal must not log the workout twice.
B.queueOutbox(ATH, "Bench 3x5 225");
check("exact duplicate at the tail is not re-queued", B.readOutbox(ATH).length === 1);
B.queueOutbox(ATH, "Squat 5x5 315");
check("a different message IS queued", B.readOutbox(ATH).length === 2);
B.queueOutbox(ATH, "Bench 3x5 225");
check("the same text later in the session is allowed again", B.readOutbox(ATH).length === 3);
check("empty text is never queued", B.queueOutbox(ATH, "   ").length === 3);

const { item, rest } = B.shiftOutbox(ATH);
check("shift returns the OLDEST first (send order preserved)", item.text === "Bench 3x5 225" && rest.length === 2);
check("shift persists the remainder", B.readOutbox(ATH).length === 2);

reset();
check("shift on an empty queue is a no-op", B.shiftOutbox(ATH).item === null);

reset();
B.queueOutbox(ATH, "old one", { now: Date.now() - (B.OUTBOX_MAX_AGE_MS + 1000) });
check("a day-old queued log is dropped, not sent as if it were today", B.readOutbox(ATH).length === 0);

// The Quick Log pure-log flag has to survive the offline gap: a draft that replays
// without it can be classified as a program and overwrite program_text.
reset();
B.queueOutbox(ATH, "Upper A\nBench 185x5", { pure: true });
check("pure flag is stored", B.readOutbox(ATH)[0].pure === true);
check("pure flag survives the shift", B.shiftOutbox(ATH).item.pure === true);
// The focus note cost a Sonnet call — it must survive the offline gap too.
reset();
B.queueOutbox(ATH, "Upper A", { pure: true, note: "Heavy bench day — 89% of your 275." });
check("focus note is queued with the draft", B.readOutbox(ATH)[0].note === "Heavy bench day — 89% of your 275.");
check("no note → null, not undefined", B.queueOutbox("other", "x")[0].note === null);
reset();
B.queueOutbox(ATH, "Upper A", { note: "x".repeat(5000) });
check("a runaway note is capped", B.readOutbox(ATH)[0].note.length === 1200);
reset();
store.set(B.outboxKey(ATH), JSON.stringify([{ text: "x", at: Date.now(), pure: "yes" }]));
check("pure is normalized to a boolean", B.readOutbox(ATH)[0].pure === true);

reset();
for (let i = 0; i < B.OUTBOX_MAX + 15; i++) B.queueOutbox(ATH, "msg " + i);
check("queue is capped", B.readOutbox(ATH).length === B.OUTBOX_MAX);
check("cap keeps the NEWEST messages", B.readOutbox(ATH).at(-1).text === "msg " + (B.OUTBOX_MAX + 14));

reset();
B.queueOutbox(ATH, "x");
B.clearOutbox(ATH);
check("clear empties the queue", B.readOutbox(ATH).length === 0);
reset();
store.set(B.outboxKey(ATH), "{not json");
check("corrupt outbox reads as empty", B.readOutbox(ATH).length === 0);
reset();
store.set(B.outboxKey(ATH), JSON.stringify([{ nope: 1 }, { text: "  " }, { text: "ok", at: Date.now() }]));
check("malformed entries are filtered out", B.readOutbox(ATH).length === 1);

console.log(`\nboot: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
