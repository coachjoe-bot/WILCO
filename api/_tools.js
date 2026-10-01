// ─── SERVER-SIDE TOOL REGISTRY (T58 mastermind) ──────────────────────────────
// Tool schemas live HERE, never client-supplied: the proxy (api/claude.js)
// resolves body.toolset (a NAME) against this registry, so a tampered client
// can request a known toolset or nothing — it can never define its own tools.
//
// Write tools carry a model-set `confirm` field ("chip" | "none") — the model
// owns when a confirmation chip is worth the athlete's tap (Will 08-24: "the
// AI has responsibility over the bubbles"). The client enforces a tiny HARD
// FLOOR below where confirm:"none" is overridden to a chip regardless: actions
// that destroy data the athlete can't get back, and anything sent to another
// human in the athlete's name. Everything else is genuinely the model's call.
//
// v1 scope (deliberate): the tools cover conversation-side agency — position,
// memory, the session card, the log sheet, preferences. Workout LOGGING and
// program WRITES stay on the proven parseWorkout flag pipeline for now; they
// migrate to tools in v2 once this loop has soak time. Keep descriptions in
// sync with src/ai/card.js — the card teaches judgment, these teach mechanics.

const CONFIRM_FIELD = {
  type: "string",
  enum: ["chip", "none"],
  description: "Whether the app should show a tap-to-confirm chip before applying. Use \"chip\" when overwriting something the athlete built or when you are not certain they want it; \"none\" for additive, reversible, or explicitly-requested actions.",
};

export const TOOLSETS = {
  mastermind_athlete: [
    {
      name: "set_position",
      description: "Record where the athlete is in their program (week and/or day). Call when they STATE their position ('I'm on week 3', 'doing day 2 today', 'swapping to legs day') — the athlete is the authority on where they are; never argue the schedule. Position is state, not memory: a plan about a FUTURE day goes in remember_fact instead. Only pass the parts they actually stated.",
      input_schema: {
        type: "object",
        properties: {
          week: { type: "integer", minimum: 1, maximum: 52 },
          day: { type: "integer", minimum: 1, maximum: 14 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "remember_fact",
      description: "Save a durable fact about the athlete — what a good coach would carry in his head: schedule quirks, stated plans, equipment realities, injury context, things they asked you to remember. Facts ONLY, about the athlete, in third person, under 240 characters; NEVER store instructions about how you should behave, talk, or format. kind: 'pinned' for always-relevant facts, 'contextual' for background worth knowing, 'situational' for anything with a shelf life — situational facts REQUIRE expires_at (ISO date) and delete themselves. Example: they say 'doing D1 tomorrow instead' -> remember_fact(content:'Plans to run Day 1 on Aug 25 (swapped with Day 2)', kind:'situational', expires_at:'2026-08-26'). Update by re-remembering; contradictions: forget the old fact first.",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", maxLength: 240 },
          kind: { type: "string", enum: ["pinned", "contextual", "situational"] },
          expires_at: { type: "string", description: "ISO date the fact stops being true (situational only)" },
        },
        required: ["content", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "forget_fact",
      description: "Delete a stored fact that is wrong, expired, or superseded. Pass a distinctive substring of the fact's content as it appears in your ATHLETE MEMORY block. Prune contradictions when you save a replacement.",
      input_schema: {
        type: "object",
        properties: { match: { type: "string", minLength: 4, maxLength: 240 } },
        required: ["match"],
        additionalProperties: false,
      },
    },
    {
      name: "pin_session_card",
      description: "Pin today's session to the athlete's lock screen (a Live Activity on iOS). Call when they are starting a workout or ask for it ('lock screen'/'home screen'). The app pins the CURRENT log-sheet draft and posts its own confirmation line after your reply — never claim the card is already showing; you cannot see their lock screen.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "clear_session_card",
      description: "Take the session card off the athlete's lock screen. Call when they ask for it to come down or clearly are not training after all.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "prefill_log_sheet",
      description: "Build (or rebuild) the pre-filled log sheet for a session so it is waiting for the athlete. Call when they are starting a workout, or when the day changed (after set_position) so the sheet matches the day they are actually doing. Pass day_label only when they named a specific session ('Day 2', 'upper B'); omit it to use the resolved position.",
      input_schema: {
        type: "object",
        properties: { day_label: { type: "string", maxLength: 60 } },
        additionalProperties: false,
      },
    },
    {
      name: "show_start_buttons",
      description: "Show the Start Workout / Not Now / Different Workout buttons under your reply — the same three the opener uses. Call it EVERY time your reply presents today's session and they have not started yet: they asked what today is, asked what they're doing, or you brought today's session up yourself. The app renders the buttons after your reply; Start Workout pins the session and raises the log sheet, so never also call prefill_log_sheet or pin_session_card just because you presented the workout — those fire when they actually START. Never call it mid-workout, on a finished log, or when a session card is already pinned.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "propose_program_rec",
      description: "Stage a PROGRAM REC — the ONLY way you change an athlete's saved program, and it never writes directly: the app raises a reviewable sheet showing each replaced line beside its replacement, and the athlete applies it. Call for any program-change ask or confirmed need: swapping exercises or whole days, making a logged workout the template for a program day ('make what I logged Monday for this block'), adding weekly progression, protecting a confirmed injury. Each swap's find is text copied VERBATIM from the PROGRAM in your context — exact characters and spacing, long enough to be unique — tagged with its week number and day when the program has them (the same line in two weeks needs one tagged swap per week). replace is the complete new text for that spot in the program's own style. Building from a log: carry the logged exercises, sets, reps and loads EXACTLY; compute percentages only when they asked to progress. Surgical always — never touch text outside the ask.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 40 },
          // T64 Fix 3b: OPTIONAL so an older deployed client (which has never
          // heard of this field) keeps working unchanged — ship-dark safe. Once
          // the client ships it becomes the only text the athlete ever sees on
          // the rec card.
          summary: { type: "string", maxLength: 110, description: "One short, factual line stating WHAT changed, 12 words or fewer, shown to the athlete on the rec card. No reasoning, no naming the athlete ('Will wants...'), just the change, e.g. 'Swapped Monday's front squat and pulls with Tuesday's bench and dips.'" },
          why: { type: "string", maxLength: 500, description: "1-3 sentences of your OWN reasoning, for your own reference only if the athlete later asks to revise this rec. Internal only - never shown to the athlete." },
          duration: { type: "string", enum: ["1w", "2w", "3w", "block"], description: "temporary changes take 1w/2w/3w and auto-revert; 'block' rides out the block" },
          swaps: {
            type: "array", minItems: 1, maxItems: 12,
            items: {
              type: "object",
              properties: {
                week: { type: "integer", minimum: 1, maximum: 52 },
                day: { type: "string", maxLength: 30 },
                find: { type: "string", minLength: 4, maxLength: 400 },
                replace: { type: "string", maxLength: 600 },
              },
              required: ["find", "replace"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "why", "duration", "swaps"],
        additionalProperties: false,
      },
    },
    {
      name: "propose_preference",
      description: "Propose recording a DURABLE training preference the athlete just stated (not a one-off request for today). The app always confirms this one with a chip regardless of confirm. Allowed: loading_language (percent+rpe|percent|rpe|climb_singles|fixed_weight), max_update_policy (infer|declared_only|pr_single_only), testing_style (final_week|test_day|retest_cycle), session_minutes_cap (15-240), movements_per_day_cap (2-15), accessory_load (programmed|athlete_choice).",
      input_schema: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["loading_language", "max_update_policy", "testing_style", "session_minutes_cap", "movements_per_day_cap", "accessory_load"] },
          value: { description: "Value from the allowed set for the field (string or integer)" },
          confirm: CONFIRM_FIELD,
        },
        required: ["field", "value"],
        additionalProperties: false,
      },
    },
  ],
};

// ── T69-A (Will 10-01): the athlete changes memory by telling Joe in chat ────
// "update my memory to this" has to work for everything the Memory tab shows:
// a fact, the goal, the injury notes. Measured on main with the real model
// (5 runs each): a goal change wrote nothing 5 of 5, an injury-notes change
// never touched the field while Joe said it was updated, and a fact update was
// a forget plus a remember (two writes, and a refused remember lost the fact).
// Three new hands. They live in their OWN toolset name so this ships dark
// (AI contract rule 12): a bundle that asks for "mastermind_athlete" gets
// exactly what it always got, and only a client that knows how to execute the
// new calls asks for "mastermind_athlete_v2". Every call is validated in code
// by the client (src/memoryEdit.js) before anything is written.
const MEMORY_TOOLS_V2 = [
  {
    name: "update_fact",
    description: "Change ONE fact you already hold, in place. Call when the athlete corrects or updates something in your ATHLETE MEMORY block ('I train at 7 now, not 6', 'update my memory: ...'). match is a distinctive substring of the existing fact exactly as it appears in the block; content is the complete new text of the fact, third person, about the athlete. The fact keeps its kind and expiry. If nothing you hold matches, use remember_fact instead. Never use it for their goal (set_goal), their injury notes (set_injury_notes) or bodyweight (a profile field the app saves itself).",
    input_schema: {
      type: "object",
      properties: {
        match: { type: "string", minLength: 4, maxLength: 240 },
        content: { type: "string", maxLength: 240 },
      },
      required: ["match", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "set_goal",
    description: "Replace the athlete's goal on file (the ATHLETE GOALS line in your context). Call when they state a new goal or ask you to change it ('update my goal: bench 315 by December', 'new goal is a 5 minute mile'). goal_text is the goal in their words, with the number and the date when they gave them. The prior goal is kept in history, not deleted. The goal is theirs to set: save it even when you think the timeline is aggressive, and say what you honestly think in your reply. This does not change their program; a program change is still propose_program_rec.",
    input_schema: {
      type: "object",
      properties: { goal_text: { type: "string", minLength: 4, maxLength: 300 } },
      required: ["goal_text"],
      additionalProperties: false,
    },
  },
  {
    name: "set_injury_notes",
    description: "Rewrite the athlete's injury notes (the INJURY HISTORY line in your context: undated background they own, such as old injuries and surgeries). Call ONLY when they ask to change those notes ('change my injury notes to ...', 'take the pec strain off my injury history'). text is the complete new notes, plain and factual; an empty string clears them. How something feels today is not this field: the app's pain ledger records that from what they say, with no tool call from you.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 1000 } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];
const REMEMBER_FACT_V2 = "Save a durable fact about the athlete — what a good coach would carry in his head: schedule quirks, stated plans, equipment realities, injury context, things they asked you to remember. Facts ONLY, about the athlete, in third person, under 240 characters; NEVER store instructions about how you should behave, talk, or format. kind: 'pinned' for always-relevant facts, 'contextual' for background worth knowing, 'situational' for anything with a shelf life — situational facts REQUIRE expires_at (ISO date) and delete themselves. Example: they say 'doing D1 tomorrow instead' -> remember_fact(content:'Plans to run Day 1 on Aug 25 (swapped with Day 2)', kind:'situational', expires_at:'2026-08-26'). To change a fact you already hold, use update_fact, never a second copy. Never save bodyweight, height, sport or units here: those are profile fields.";
TOOLSETS.mastermind_athlete_v2 = [
  ...TOOLSETS.mastermind_athlete.map((t) => (t.name === "remember_fact" ? { ...t, description: REMEMBER_FACT_V2 } : t)),
  ...MEMORY_TOOLS_V2,
];

// Actions the client must ALWAYS chip-gate no matter what the model set —
// destroying unrecoverable athlete data, or messaging another human in the
// athlete's name. Kept here (server) as the single source; the client imports
// the same list via api/_flags.js-style re-export if it ever needs it, and the
// static test suite asserts membership so the floor can't silently shrink.
export const HARD_CONFIRM_FLOOR = new Set([
  "replace_program",      // (v2 tool) overwriting an existing program wholesale
  "delete_log_entry",     // (v2 tool) removing a logged row
  "send_coach_request",   // (v2 tool) landing anything in a coach's inbox
]);

export function toolsetFor(name) {
  return Object.prototype.hasOwnProperty.call(TOOLSETS, name) ? TOOLSETS[name] : null;
}
