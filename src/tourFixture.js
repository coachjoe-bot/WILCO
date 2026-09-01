// ─── FIRST-RUN TOUR: SAMPLE DATA ─────────────────────────────────────────────
// Every screen the tour walks through has to have something on it. A brand-new
// athlete has no program, no history, no numbers and no Proof, so the tour would
// otherwise be a walk through five empty states — which teaches nothing and
// reads as a broken app.
//
// Everything here is DISPLAY-ONLY. Nothing in this file is ever written: the
// surfaces read it through a `demo` prop while the tour is running and go back
// to the athlete's own data the moment it ends (finish OR skip — see
// tourTeardown in App.jsx). This is the same seam QuickLogSheet has used for the
// sample log since the first tour shipped.
//
// COMMON MOVEMENTS ON PURPOSE (Will, 09-01): the tour is the first thing a new
// athlete sees, and most of them are not weightlifters. Barbell basics in
// pounds, no snatches, no cleans.
//
// Every surface that shows this data labels it SAMPLE. An athlete must never
// finish the tour thinking they already have sessions on file.

const A = "tour-sample-athlete";

// Row shape mirrors what the parser actually writes (see scripts/seed-qa-athlete.mjs)
// so the display components run their real code paths against it.
const ex = (name, sets, reps, weight, unit = "lbs", extra = {}) => ({
  name, sets, reps, weight, unit, added_weight: null, assist_weight: null, resistance: null,
  load_basis: null, rpe: null, rir: null, percent_1rm: null, tempo: null, technique: null,
  to_failure: null, superset_group: null, feel: null, notes: null, set_details: null, ...extra,
});

// Fixed offsets from "now" at tour time. Not frozen dates: a hardcoded calendar
// date would read as stale the week after it shipped.
const daysAgo = (n, h = 17) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 30, 0, 0);
  return d.toISOString();
};

const workout = (id, dAgo, focus, exercises, reply) => ({
  id: `tour-w${id}`,
  athlete_id: A,
  created_at: daysAgo(dAgo),
  raw_message: exercises
    .map((e) => `${e.name} ${e.sets}x${e.reps}${e.weight ? ` @ ${e.weight}` : ""}`)
    .join(", "),
  bot_reply: reply,
  focus_note: focus,
  parsed_data: {
    log_date: null, run_data: null, exercises,
    coach_flag: null, pain_flags: [], pr_attempts: [],
  },
});

// The program the whole tour runs off. Day 2 is the session they start in step
// 12, log in step 14, and see again in My Log, Progress and The Proof.
export const TOUR_PROGRAM_TEXT = `DAY 1 - SQUAT
Back Squat 4x5 @ 225
Romanian Deadlift 3x8 @ 185
Walking Lunge 3x10

DAY 2 - BENCH
Bench Press 3x5 @ 175
Bench Press 1x1 @ 190
Incline DB Press 3x10 @ 60
Chest-Supported Row 3x12 @ 120
Tricep Pushdown 3x15 @ 45

DAY 3 - DEADLIFT
Deadlift 4x3 @ 275
Weighted Pull-Up 4x6
Barbell Row 3x8 @ 135

DAY 4 - PRESS
Overhead Press 4x5 @ 115
Dip 3x8
Lateral Raise 3x15 @ 20`;

// Six sessions across three weeks. Enough for the Strength tab to draw a real
// climb and for Benchmarks to rank something, without pretending to be a career.
// The bench line walks 170 → 175 → 190 so the PR in step 16 is the top of a
// trend the athlete can see, not a number that appears from nowhere.
export const TOUR_HISTORY = [
  workout(1, 0, "Day 2 - Bench. Straight progression from last week, no percentage climb.", [
    ex("Bench Press", 3, 5, 175),
    ex("Bench Press", 1, 1, 190),
    ex("Incline DB Press", 3, 10, 60),
    ex("Chest-Supported Row", 3, 12, 120),
    ex("Tricep Pushdown", 3, 15, 45),
  ], "Workout Logged. Good job on that bench press personal record. I am updating your numbers to reflect the new max. Rows and pushdowns are in the book too."),
  workout(2, 2, "Day 1 - Squat. Volume day, knees felt fine throughout.", [
    ex("Back Squat", 4, 5, 225),
    ex("Romanian Deadlift", 3, 8, 185),
    ex("Walking Lunge", 3, 10, null),
  ], "Solid work. Squat volume is holding at 225 and that is the lift your October goal rides on."),
  workout(3, 4, "Day 3 - Deadlift. Pull day, straight sets.", [
    ex("Deadlift", 4, 3, 275),
    ex("Weighted Pull-Up", 4, 6, 25),
    ex("Barbell Row", 3, 8, 135),
  ], "Good pulling. 275 for four triples is real work off the floor."),
  workout(4, 7, "Day 4 - Press. Overhead and shoulders.", [
    ex("Overhead Press", 4, 5, 115),
    ex("Dip", 3, 8, null),
    ex("Lateral Raise", 3, 15, 20),
  ], "Press is moving. Keep the ribs down on the top set."),
  workout(5, 9, "Day 2 - Bench. Building toward a heavier single.", [
    ex("Bench Press", 3, 5, 170),
    ex("Incline DB Press", 3, 10, 55),
    ex("Chest-Supported Row", 3, 12, 115),
  ], "Clean session. Bench at 170 for three fives sets up next week."),
  workout(6, 11, "Day 1 - Squat. First week back on the squat.", [
    ex("Back Squat", 4, 5, 215),
    ex("Romanian Deadlift", 3, 8, 175),
  ], "Good first squat day. We build from here."),
];

// Athlete Context rows, in the shape AthleteContextPane renders. Kept short:
// the step is 12 words long and the document behind it only has to look real.
export const TOUR_MEMORY_ROWS = [
  { id: "tour-m1", athlete_id: A, kind: "behavior", content: "Prefers barbell work early in the session.", expires_at: null, created_at: daysAgo(6) },
  { id: "tour-m2", athlete_id: A, kind: "situational", content: "Left knee is the one to watch. No deep lunging while it settles.", expires_at: null, created_at: daysAgo(9) },
];

export const TOUR_GOALS = [
  { id: "tour-g1", athlete_id: A, goal_text: "Add 30 lbs to the back squat by October.", created_at: daysAgo(12) },
];

// Past Blocks: one finished phase and one running, which is what the pane shows
// for anybody who has trained a while.
export const TOUR_BLOCKS = [
  {
    id: "tour-b1", block_name: "SUMMER BASE", source: "manual",
    applied_at: daysAgo(56), completed_at: null, ends_at: null,
    block_summary: "Eight-week base block. Squat volume up, bench holding, first 225 single.",
    block_recap: null,
    program_text: TOUR_PROGRAM_TEXT,
  },
  {
    id: "tour-b2", block_name: "OFF-SEASON BUILD", source: "manual",
    applied_at: daysAgo(140), completed_at: daysAgo(60), ends_at: daysAgo(60),
    block_summary: "Six weeks rebuilding after time off.",
    block_recap: "Everything moved and nothing got tested. Squat came back to 215 for sets of five, bench held where it started, and the pulling work was the most consistent thing in the block. Good base, no numbers to point at yet.",
    program_text: null,
  },
];

// Session timestamps for the Past Blocks pane. It counts sessions per phase from
// raw workout dates, so without these every sample phase reads "0 sessions
// logged" — which undercuts the exact sentence the step is making.
// 31 across SUMMER BASE, 24 across OFF-SEASON BUILD, matching their copy.
const spread = (fromDaysAgo, toDaysAgo, n) => {
  const out = [];
  const step = (fromDaysAgo - toDaysAgo) / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) out.push(daysAgo(Math.round(fromDaysAgo - step * i)));
  return out;
};
export const TOUR_BLOCK_LOGS = [
  ...spread(56, 4, 31),      // SUMMER BASE, still running
  ...spread(140, 60, 24),    // OFF-SEASON BUILD, closed
];

// Drafts: one staged program rec and one parked interview, the two things that
// actually land in that tab.
export const TOUR_DRAFTS = [
  {
    id: "tour-d1", athlete_id: A, status: "rec", title: "SWAP WALKING LUNGE FOR SPLIT SQUAT",
    updated_at: daysAgo(3),
    blueprint: { rec: { title: "Swap walking lunge for split squat", spots: 2, duration: "Rest of block" } },
  },
  {
    id: "tour-d2", athlete_id: A, status: "parked", title: "Fall Strength Block",
    updated_at: daysAgo(5),
    blueprint: { answered: 4, total: 9 },
  },
];

// The Proof. content_json.sections is the modern shape; edition_no is stamped so
// the envelope never fires its legacy count query against the real database
// while the tour is up.
export const TOUR_DIGEST = {
  id: "tour-digest-1",
  athlete_id: A,
  digest_type: "weekly",
  generated_at: daysAgo(0, 9),
  created_at: daysAgo(0, 9),
  has_plateau: false,
  content_json: {
    edition_no: 1,
    checkin_done: false,
    // LABELS MATTER. The envelope classifies sections by label to pick the
    // masthead headline, the lead column and the boxed sidebar (isRankLabel,
    // isPRLabel, isInjuryLabel, isFocusLabel). These are the exact labels
    // api/_proof.js emits, so the sample edition renders through the same
    // parsing a real one does. "STRENGTH RANKING" looks right and is wrong:
    // isRankLabel tests /\brank\b/, which does not match "RANKING", so the
    // headline silently fell back to "This Week's Proof".
    sections: [
      {
        label: "GRIT RANK",
        body: "You are holding STRONG overall this week, and your strength score is up 60 to 1140. The press side is what moved it.",
      },
      {
        label: "PRS & PROGRESS",
        body: "One PR this week: bench press 190 for a single, up from 175. That is the top of a three-week climb, not a one-off.",
      },
      {
        label: "THIS WEEK VS LAST",
        body: "Four sessions against four programmed, and every one of them got logged. Bench went up 15 pounds, squat held at 225, and the deadlift day came in exactly as written.",
      },
      {
        label: "INJURY WATCH + PLAN",
        body: "The knee stayed quiet through squat and lunge work this week. Keep it that way and there is nothing to manage here.",
      },
      {
        label: "FOCUS NEXT WEEK",
        body: "Squat has not been tested since June and your October goal rides on it. Next week we find out where it actually is.",
      },
    ],
    flags: [],
  },
};
