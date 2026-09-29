// ─── LOCK-SCREEN SESSION CARD (T40 V1) ───────────────────────────────────────
// Today's session pinned to the lock screen as a notification, so the athlete
// glances between sets instead of unlocking, opening the app, and waiting.
//
// The rules this feature lives by (Will, 2026-08-10):
//   • The card is a PROJECTION of the Quick Log draft — the app's one canonical
//     "today's session, number-first, position-resolved" artifact. It is never
//     built from model chat text, and nothing here re-derives position or
//     weights (coach-brain lesson: compute facts in code, hand them over).
//   • Static reference sheet: no check-offs, no progress. Logging the workout
//     clears the whole card; that's the only "done" state it has.
//   • It exists only when the athlete said yes to the chat offer. No cron, no
//     scheduled time, nothing appears unasked.
//
// V1 delivery is a web notification via the service worker (tag-replaced on
// update, closed on log) — every current user is on the PWA. The native
// Live Activity rides a post-launch App Store update along with
// @capacitor/local-notifications; ios/ is deliberately untouched while the T23
// submission is in flight.

import { qlLocalDay, QL_RESUME_MS } from "./quicklog.js";

export const SESSION_CARD_TAG = "wilco-session-card";
// An abandoned session shouldn't haunt the lock screen: past this age the card
// is stale and gets cleared on the next app open (the web platform has no
// self-expiring notifications, so expiry is enforced at boot).
// The cap is the Quick Log draft's own resume window — the card is a projection
// of that draft, so their lives must match. The old 3h cap died before the 8h
// draft (and before iOS's own 8h Live Activity limit): a native Live Activity
// stayed pinned while activeSessionCard() already said dead, so the mirror
// stopped, the sheet regenerated freely, and lock screen and app disagreed.
export const SESSION_CARD_MAX_AGE_MS = QL_RESUME_MS;

const cardKey = (athleteId) => `wilco_sessioncard_${athleteId}`;
const declineKey = (athleteId) => `wilco_sessioncard_declined_${athleteId}`;

// ── the chat trigger ─────────────────────────────────────────────────────────
// Deterministic intent match for "Joe is about to serve today's session" — the
// same phrasings the chat prompt's today's-workout rule enumerates, plus
// "start my workout". The offer only ever rides one of these; a model reply
// never decides whether to offer (nothing for it to get wrong).
export const TODAYS_WORKOUT_RE =
  /what(?:'|’)?s?\s+(?:my|the|on|today)(?:[a-z'’ ]{0,12})?\s*(?:workout|session|training|lift(?:ing)?|program)?\s*(?:for\s+)?today|what\s+am\s+i\s+(?:doing|lifting|training)\s+today|show\s+me\s+today(?:'|’)?s?\s+(?:workout|session)|today(?:'|’)?s?\s+(?:workout|session)\b|start\s+(?:my|the|today(?:'|’)?s?)\s+workout/i;
export const asksTodaysWorkout = (msg) => TODAYS_WORKOUT_RE.test(String(msg || ""));

// T55: the direct ask — "put my program/workout on my lock screen", "pin it to my
// lock screen", "add today's session to the lock screen", "lock screen widget".
// Joe DENIED this exact request in TestFlight because only the what's-today
// phrasings above triggered the offer, and his prompt had no feature inventory to
// know better. Any lock-screen mention aimed at the program/workout now offers
// the card through the same deterministic path.
export const LOCKSCREEN_RE =
  /lock\s*screen|lockscreen|home\s*screen|homescreen/i;
export const asksLockScreenCard = (msg) => {
  const t = String(msg || "");
  return LOCKSCREEN_RE.test(t) && /\b(put|pin|add|show|get|keep|throw|set|program|workout|session|card|widget)\b/i.test(t);
};

// T56 (Will's spec, 08-18): "when I say I'm starting my workout and notifications
// are on, the card should just appear." Session-start intent — the third
// deterministic trigger alongside what's-today and the explicit lock-screen ask.
export const STARTING_WORKOUT_RE =
  /\b(start(?:ing)?|about to (?:start|do|hit)|beginning|kicking off)\b[^.!?\n]{0,30}\b(workout|session|lift(?:ing)?|training)\b|\b(?:i'?m |im |just got )(?:at|to|heading to|walking into|on my way to) the gym\b/i;
// Past-tense talk ("benched at the gym yesterday") is a LOG, not a session start —
// it would pin a card the log immediately clears.
const PAST_TENSE_RE = /\b(yesterday|last (?:night|week)|earlier|this morning|logg?ed|did|finished|done)\b/i;
export const asksStartingWorkout = (msg) => {
  const t = String(msg || "");
  return STARTING_WORKOUT_RE.test(t) && !PAST_TENSE_RE.test(t);
};

// An exercise change said in chat ("subbed dips for pushdowns"). While a
// session is up it has to reach the sheet and the card.
export const SWAP_RE = /\bsub(?:bed|bing|stitut\w*)?\b|\bswap(?:ped|ping)?\b|\binstead of\b|\breplac(?:e|ed|ing)\b/i;
export const saysSwap = (msg) => SWAP_RE.test(String(msg || ""));

// ── card content, from the draft ─────────────────────────────────────────────
// Input is the Quick Log draft's log text: first line = day label, then one
// exercise per line "Name SETSxREPS @ WEIGHT (source)". The card shows real
// weights and drops the source tags — "@ 225", never "@ 75%" (Will's call).
const SOURCE_TAG_RE = /\s*\((?:~?\d+(?:\.\d+)?\s*%[^)]*|RPE[^)]*|last time[^)]*)\)\s*$/i;

export const buildSessionCard = (draftText, { week } = {}) => {
  const lines = String(draftText || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const dayLabel = lines[0].replace(/[:\-–—\s]+$/, "");
  const exercises = lines.slice(1).map((l) => l.replace(SOURCE_TAG_RE, ""));
  if (!exercises.length) return null;
  // "PUSH A · WEEK 3" — never repeat a week the label already states. Uppercase:
  // the card is a headline on the lock screen, not a sentence.
  const weekTag = week && !/\bw(?:ee)?k\s*\d/i.test(dayLabel) ? ` · Week ${week}` : "";
  return {
    title: `${dayLabel}${weekTag}`.toUpperCase(),
    body: exercises.slice(0, 12).join("\n"),
  };
};

// ── explicit removal ─────────────────────────────────────────────────────────
// The card never expires on its own mid-workout and re-pins itself when buried,
// so the athlete needs a way OFF: telling Joe. Deterministic — no AI turn.
export const ASKS_CLEAR_CARD_RE =
  /\b(?:clear|remove|take|get\s+rid\s+of|kill|delete|dismiss)\b[^.!?\n]{0,50}\b(?:lock\s*-?\s*screen|notification|session\s+card|the\s+card|pin(?:ned)?)\b|\b(?:lock\s*-?\s*screen|pin|card|notification)\b[^.!?\n]{0,30}\b(?:off|away|down|gone)\b/i;
export const asksClearCard = (msg) => ASKS_CLEAR_CARD_RE.test(String(msg || ""));

// ── platform support / permission ────────────────────────────────────────────
// Native Live Activity when the shell provides it (the SessionCard Capacitor
// plugin, ios/App/WilcoSessionCard) — a truly PINNED lock-screen surface that
// other notifications can't bury and Clear All can't sweep.
//
// WEB PARITY RULING (Will 08-29): notifications are the ONE deliberate
// platform difference — the web app never offers them, so the old
// web-notification card fallback (post + re-pin cycle) is retired. On web the
// session lives on the in-chat workout bar instead; every card call site
// already degrades through this returning false ("Log it here when you're
// done"). The web helpers below stay for clear/expiry hygiene on cards that
// predate this ruling.
const nativeSessionCard = () =>
  (typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() &&
   window.Capacitor?.Plugins?.SessionCard) || null;

export const sessionCardSupported = () => !!nativeSessionCard();

// ── show / clear / re-pin ────────────────────────────────────────────────────
// Web path posts under one tag, so an update silently REPLACES the pinned card
// instead of stacking a second one.
const postWebCard = async (title, body) => {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(title, {
    body,
    tag: SESSION_CARD_TAG,
    renotify: false,
    silent: true, // a reference sheet, not an alert — no buzz on show or update
    // Desktop/Android: keep it on screen until the athlete deals with it.
    // iOS ignores this — its persistence comes from the re-pin cycle below.
    requireInteraction: true,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: "/", type: "session_card" },
  });
};

// The app's own dark-mode flag (localStorage, module-eval'd in App.jsx). Read
// lazily and defensively here so this module stays import-cycle-free and
// testable in node — the native card can't see the WebView's storage, so every
// show()/update() hands the current theme over.
const isDarkTheme = () => {
  try { return localStorage.getItem("wilco_theme") === "dark"; } catch (_) { return false; }
};

// Notifications must be ON for WILCO before anything lands on a lock screen
// (Will, 08-11). On native that's the OS notification permission — Live
// Activities have their own switch, but an athlete who denied notifications
// should never get a pinned card, so this gates on the real permission and
// asks for it if it has never been answered.
const nativeNotificationsGranted = async () => {
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    let { receive } = await PushNotifications.checkPermissions();
    if (receive === "prompt" || receive === "prompt-with-rationale") {
      ({ receive } = await PushNotifications.requestPermissions());
    }
    return receive === "granted";
  } catch (_) { return false; }
};

export const showSessionCard = async (athleteId, card) => {
  if (!card || !sessionCardSupported()) return false;
  try {
    const native = nativeSessionCard();
    if (native) {
      if (!(await nativeNotificationsGranted())) return false;
      await native.show({ title: card.title, body: card.body, dark: isDarkTheme() });
    } else {
      let perm = Notification.permission;
      if (perm === "default") {
        try { perm = await Notification.requestPermission(); } catch (_) { return false; }
      }
      if (perm !== "granted") return false;
      await postWebCard(card.title, card.body);
    }
    const existing = readCardState(athleteId);
    writeCardState(athleteId, {
      day: qlLocalDay(),
      // An update keeps the original start time — the card "started" when the
      // athlete first pinned it, not when it last re-rendered.
      startedAt: existing && existing.day === qlLocalDay() ? existing.startedAt : Date.now(),
      // Content is stored so the re-pin cycle can re-post without a rebuild.
      title: card.title,
      body: card.body,
    });
    return true;
  } catch (_) { return false; }
};

// iOS gives a web app no pinned surface: newer notifications bury the card and
// "Clear All" sweeps it. So the app re-posts the stored card every time it goes
// to the background — lock the phone mid-workout and the card rides back to the
// top of the stack, and a swept card comes back on the next cycle. Removal is
// deliberate only: log the session, or tell Joe to take it down. (The native
// Live Activity needs none of this — a started activity just stays.)
export const repinSessionCard = async (athleteId) => {
  const d = readCardState(athleteId);
  if (!sessionCardIsLive(d) || !d.title || !d.body) return;
  if (nativeSessionCard()) return; // a Live Activity is already pinned
  if (!sessionCardSupported() || Notification.permission !== "granted") return;
  try { await postWebCard(d.title, d.body); } catch (_) {}
};

export const clearSessionCard = async (athleteId) => {
  try { localStorage.removeItem(cardKey(athleteId)); } catch (_) {}
  try {
    const native = nativeSessionCard();
    if (native) { await native.end(); return; }
  } catch (_) {}
  if (!sessionCardSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    (await reg.getNotifications({ tag: SESSION_CARD_TAG })).forEach((n) => n.close());
  } catch (_) {}
};

const readCardState = (athleteId) => {
  try { return JSON.parse(localStorage.getItem(cardKey(athleteId)) || "null"); } catch (_) { return null; }
};
const writeCardState = (athleteId, state) => {
  try { localStorage.setItem(cardKey(athleteId), JSON.stringify(state)); } catch (_) {}
};

// Pure staleness rule, exported for tests: a card is live only same-local-day
// and under the age cap.
export const sessionCardIsLive = (state, now = Date.now()) =>
  !!state && state.day === qlLocalDay(now) && now - (state.startedAt || 0) <= SESSION_CARD_MAX_AGE_MS;

// The card the app believes is currently pinned, or null. Never clears — the
// boot path owns that (expireSessionCardIfStale), so a stale read here can't
// race a show in progress.
export const activeSessionCard = (athleteId) => {
  const d = readCardState(athleteId);
  return sessionCardIsLive(d) ? d : null;
};

// Boot-time expiry: yesterday's card, or one past the age cap, comes down.
export const expireSessionCardIfStale = async (athleteId) => {
  const d = readCardState(athleteId);
  if (d && !sessionCardIsLive(d)) await clearSessionCard(athleteId);
};

// ── workout start clock (T62 session duration) ───────────────────────────────
// One stamp per day, FIRST start wins (the one-event rule's sibling: re-pins,
// day corrections and sheet rebuilds must not restart the clock). Stamped by
// every "workout started" event — Start Workout tap, pin (model or auto), the
// zero-tap starting-now pin — and consumed by finalizeWorkout, which records
// duration only for a real same-day log inside sane bounds. A card pinned by an
// older path without an explicit stamp still counts: the card state's own
// startedAt is the fallback clock.
const startKey = (athleteId) => `wilco_workoutstart_${athleteId}`;

export const markWorkoutStart = (athleteId, now = Date.now()) => {
  try {
    const cur = JSON.parse(localStorage.getItem(startKey(athleteId)) || "null");
    if (cur && cur.day === qlLocalDay(now) && now - cur.at <= SESSION_CARD_MAX_AGE_MS) return;
    localStorage.setItem(startKey(athleteId), JSON.stringify({ day: qlLocalDay(now), at: now }));
  } catch (_) {}
};

export const workoutStartAt = (athleteId, now = Date.now()) => {
  try {
    const cur = JSON.parse(localStorage.getItem(startKey(athleteId)) || "null");
    if (cur && cur.day === qlLocalDay(now) && now - cur.at <= SESSION_CARD_MAX_AGE_MS) return cur.at;
  } catch (_) {}
  const card = activeSessionCard(athleteId);
  return card && card.startedAt ? card.startedAt : null;
};

export const clearWorkoutStart = (athleteId) => {
  try { localStorage.removeItem(startKey(athleteId)); } catch (_) {}
};

// Pure duration rule, exported for tests: elapsed seconds from a start clock to
// the log landing, or null when it would be garbage. Backdated logs never reach
// this (the caller gates on same-local-day); under 5 minutes means the athlete
// is typing up a session that happened somewhere else, over the 8h draft window
// means an abandoned clock — neither is a real duration.
export const workoutDurationSeconds = (startAt, now = Date.now()) => {
  if (!Number.isFinite(startAt)) return null;
  const el = Math.round((now - startAt) / 1000);
  return el >= 300 && el <= SESSION_CARD_MAX_AGE_MS / 1000 ? el : null;
};

// ── one offer per day ────────────────────────────────────────────────────────
// "No thanks" means not today — the offer comes back tomorrow, not next message.
export const sessionCardDeclinedToday = (athleteId) => {
  try { return localStorage.getItem(declineKey(athleteId)) === qlLocalDay(); } catch (_) { return false; }
};
export const markSessionCardDeclined = (athleteId) => {
  try { localStorage.setItem(declineKey(athleteId), qlLocalDay()); } catch (_) {}
};
