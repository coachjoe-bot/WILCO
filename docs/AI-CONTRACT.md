# WILCO AI contract — how the AI and the code work together

Written 2026-09-28 from Will's rulings (08-10, 08-24, 08-28, 09-01, 09-28; rule 13 added 09-29) and a full audit of who decided what in the app at that time. Every session that changes AI behavior reads this first. It describes the system Will already chose; it adds no new architecture.

## Who owns what

| Owner | Owns | Never does |
|---|---|---|
| **Parser** (`parseWorkout`) | Sensing. Turns a message into data: lifts, sets, loads, dates, pain with degree, stated claims | Decide what happens next where Joe has a tool for it. Override a tool call |
| **Code** | Facts and arithmetic (position, loads, PR verdicts, performed sets, dates, pain status). Validation of every action. Truthful status lines after an action completes | Decide what to say. Post a line that repeats or contradicts Joe |
| **Joe** (the model) | Judgment and voice. Actions, only through his tools | Compute a fact code can compute. State a count, pattern or date that was not handed to him this turn. Claim an action he did not take through a tool |

## The rules

1. **Facts come from code, final.** Anything with a right answer is computed once, in one pure module, and injected into the turn. Joe quotes it. When Joe gets a fact wrong, the fix is a computed fact, never another prompt rule.
2. **One home per fact.** Dates live on the block they describe. Position comes from the resolver, keyed to the current program. Pain state lives in the pain ledger. Durable athlete facts live in `athlete_memory`, and only there (check-in notes and remember-this notes included). No second copy, no cache that can outlive what it describes.
3. **One owner per action.** Joe acts through tools; code validates each call and may drop or correct it. Where an action still runs on the parser-flag pipeline (logging and program writes, until v2), Joe's tool call in the same turn wins over the flag.
4. **Whoever decides second reads what was decided first.** Two mechanisms never decide the same visible thing independently. The later one consults the earlier one's output in code.
5. **One voice per turn.** Joe speaks. The app adds a line only to confirm an action that completed, at most one per turn, and never on a topic Joe already addressed.
6. **No claimed action without the action.** A reply that says the program changed, with no rec staged and no write made in that turn, is corrected before the athlete sees it.
7. **One source for voice.** The voice rules live in one export and every prompt that writes athlete-facing or coach-facing words imports it: chat, check-in, log sheet notes, recs, recaps, memory replies, video review, builder, proof letters, coach surfaces. Server code imports it through an `api/_*.js` shim, the same way `api/_units.js` and `api/_grit.js` work.
8. **One gate for output.** Every model-written string passes `replyGate` before it renders or is stored: tool names stripped, banned words removed, claim guard applied. A surface that skips the gate is a bug.
9. **Two texts when two readers.** What the athlete reads is short and factual. What the AI needs to remember is stored beside it and never rendered.
10. **Manner, not caps.** Answer first. No preamble, no restating what the athlete said, no filler praise. Numbers over adjectives. Stop when the point is made. Go deep when the athlete asks for depth. No profanity, ever, even when the athlete uses it.
11. **Pain is tracked quietly and spoken about rarely.** The ledger records every mention with its date and degree, counts clean sessions as recovery evidence, clears areas on its own as they improve, and reopens them if they flare. It tells every surface whether to speak. Serious reports are always addressed. Program changes for pain come from the athlete asking, or from a serious report.
12. **Server and database changes are additive.** New optional fields, new nullable columns, new allowlist entries. They ship dark before the client that uses them.
13. **A log sheet the athlete changed is theirs** (Will 09-29). What they typed on the sheet is their record of the session. It stays through an app close until the workout is finished or cancelled. Joe's tools and the app's own generators never replace it, and nothing said in chat rewrites it, by model or by code. They change it on the sheet: by typing, or by opening it and telling Joe there. A new sheet is built only when they name a different session or ask for a fresh sheet. Joe is handed the fact each turn (`sheetFactLine`). The rule is `src/sheetPlan.js`; the park that holds the sheet is `src/quicklog.js`.

## Joining the system (checklist for any new feature)

1. Is it a fact or a judgment? Facts go in a pure module with a unit suite. Judgments go in the card.
2. If Joe needs a new hand, add the tool once in `api/_tools.js`, once in the matching card section, and in the tool-name strip list.
3. If it writes words, import the voice source and pass the output through `replyGate`.
4. If it stores something, give it one home and name every reader. New columns go in every `api/data.js` allowlist they pass through, and the DB CHECK moves with the gateway enum.
5. If a second mechanism could decide the same thing, write the arbitration in code, next to the decision.
6. Add a replay case under `tests/replay/` for the scenario that motivated it.
7. Update the card if Joe's knowledge of the app changed. Nobody edits `CARD_VERSION` except the integrator of a release.

## Known departures (as of 2026-09-28)

| Departure | Status |
|---|---|
| Pain narration had no arbitration between Joe's memory notes and the code gate (2 contradictions in 6 firings, 60 days) | T64 S2 |
| Position cache could outlive the program it described | T64 S1 |
| Temp program flag could override Joe's today-only judgment | T64 S1 |
| Output filter covered about half the model-text surfaces | T64 S4 |
| Voice existed as three drifted copies (card, legacy chat prompt, proof letter) | T64 S4 |
| An area marked resolved was ignored forever, even on a flare; no shared naming for body areas | T64 S2 |
| Two memory stores (`athlete_context`, `athlete_memory`) with no reconciliation | Closed, T68 (09-29). `athlete_memory` is the one store; nothing reads or writes `athlete_context`; its lines were moved by `scripts/migrate-context-to-memory.mjs` |
| `is_program_update` / `program_append` can act on the same message as `propose_program_rec` | Closed, T68 (09-29). `programWriteOwner` (`src/recs.js`): a rec that validates and locates wins and the parser's write stands down; a rec that cannot stage is dropped and the parser's write runs alone |
| Memory could only be changed through a second AI call on the Memory tab (09-01 ruling), and chat had no hand for the goal or the injury notes: a goal ask wrote nothing 5 of 5, an injury-notes ask left the field untouched while Joe said it was updated, a stated bodyweight was saved to memory and not to the profile | Closed, T69-A (10-01, Will's reversal). The athlete edits the Memory tab directly; code is the gate (`src/memoryEdit.js` on top of `validateFact`). Joe has `update_fact`, `set_goal`, `set_injury_notes` (toolset `mastermind_athlete_v2`). Memory tool calls are awaited in `send()` and the app posts one line built from what was written (`memoryOutcomeLine`), including a plain "Not saved" when code refuses |
| Coach-side AI was never moved onto its card (`buildCoachStatic` has no call sites) | Open. T64 gives the coach side the shared voice and the pain ledger; the coach tool loop is its own wave |
