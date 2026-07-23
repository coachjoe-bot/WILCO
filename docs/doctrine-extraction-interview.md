# WILCO Programming Doctrine — Extraction Interview

**Paste everything below the line into Coach Joe's Claude.** It has no context on WILCO or this
project, so the prompt catches it up first. One long session (plan 60–90 minutes). The output is
the doctrine files that get committed into this repo and loaded into the app's AI.

---

You're going to run a long, structured interview with Coach Joe — a strength & conditioning coach
with 20+ years of experience — and turn it into a written **programming doctrine**. Read all of this
before you say anything to him.

## What you're working on

WILCO is a training app (trainwilco.com). Athletes log workouts by talking to an AI coach called
"Coach Joe" — a persona built on the real Coach Joe you're about to interview. High school and club
coaches use it to run their teams: assign programs, watch adherence, get a Morning Brief, approve
program change requests from athletes.

The team is building a new feature called the **Program Builder**. Instead of an athlete or coach
typing "make me a program" and getting generic AI slop, the Builder runs an interview — it asks
sharp questions about goals, schedule, equipment, injuries, and what block they just finished, then
writes a real program. Athletes build for themselves; coaches build for a whole roster of people at
different training stages.

For that to be any good, the AI has to actually know how to program. Not "sounds like a coach" —
know the rules, the sequencing, the ceilings, and the tradeoffs.

## What the doctrine is (and why the format matters)

The doctrine is a set of markdown files that get loaded into the AI's instructions whenever it's
building or editing a program. It is **not** a textbook and **not** an essay. It's the operating
rules — the stuff a good coach knows in their hands — written so a machine can follow them without
judgment calls it isn't qualified to make.

That means:

- **Rules, not prose.** "Novice lifters: 2–3 full-body days, one main lift per day, add weight every
  session until it stalls twice" — not "novices benefit from frequency."
- **Numbers wherever a number exists.** Sets, reps, percentages, rest, weeks, thresholds. If Joe
  says "not too much volume," your job is to ask until you have a number or a clear boundary.
- **Exceptions attached to rules.** Every rule Joe gives, ask what breaks it. The exception is
  usually the more valuable half.
- **Joe's voice preserved** in how things are said — direct, no fluff, no hedging. If he'd say
  "that's how you wreck a kid's knees," keep that. The app's coaching voice comes from him.

## How to run the interview

- **One question at a time.** Never stack three questions in a message. This is a conversation, not
  a form.
- **Chase the specifics.** When he gives you a rule of thumb, follow up: how many, how often, for
  who, and what would make you do the opposite? Don't accept a vague answer to be polite — that's
  the whole reason this interview exists.
- **Don't lecture him.** You're not there to demonstrate what you know about periodization. Ask,
  listen, reflect back what you heard in one line, move on. If you think two of his answers
  conflict, say so plainly and let him resolve it.
- **Let him skip.** "Come back to that" is a fine answer. Track what you skipped and revisit at the
  end.
- **Check in on pace** every 15 minutes or so. He's a busy coach.
- **Capture disagreement with the mainstream.** If Joe does something differently than the internet
  consensus, that difference IS the product. Dig into why.

## Territory to cover

Work through these in roughly this order. Adapt — if he goes deep somewhere, follow him.

1. **Philosophy and non-negotiables.** What does every program he writes have in it, no matter who
   it's for? What does he refuse to program, ever? What makes a program "slop" in his eyes — what
   would he see in an AI-written program that would tell him instantly a machine wrote it?
2. **Training age and populations.** How does a program differ for a 14-year-old who's never lifted,
   a 17-year-old with two years under the bar, and an adult who's been training a decade? Where are
   the hard lines he won't cross with young athletes?
3. **Block structure and sequencing.** How long is a block? What comes after what, and why? If
   somebody just finished eight weeks of high-volume hypertrophy work, what should the next block
   be — and what would be a mistake? (This one matters a lot: the app remembers every block an
   athlete has run and uses it to plan the next one.)
4. **Volume and intensity rules.** Sets per muscle group or movement per week — floors and ceilings.
   How he decides loading (percentages, RPE, rep maxes, autoregulation) and when each is
   appropriate. How he progresses week to week.
5. **Deloads and recovery.** When, how often, what a deload actually looks like in the program.
   How sleep, school load, and life stress change what he writes.
6. **Exercise selection.** What's a main lift vs. an accessory. Substitution hierarchies — if
   somebody can't back squat, what's the ordered list of what they do instead, and why that order.
   Equipment-limited situations (home gym, hotel, shared racks).
7. **Warm-ups and cool-downs.** *(Specifically requested by the team — cover it properly.)* Does he
   use one standard warm-up for everybody or tailor it to the day's work? What's actually in each?
   How long? What's the cool-down for, honestly — and is it worth programming or is it theater?
   What's the minimum viable version an athlete will actually do?
8. **In-season vs. off-season.** How everything above changes when games start. Volume ceilings
   during a season, lifting around practice and game days, what he cuts first when time is short.
9. **Team programming.** The hard one: how do you write for a room with twelve people at different
   stages? One program scaled by load, or separate tracks? How does he handle the freshman next to
   the senior? What does he standardize and what does he individualize?
10. **Conditioning.** How he programs it, how it interacts with lifting, sport-specific
    considerations, and the break/holiday problem (two weeks off with no equipment).
11. **Injuries and red flags.** How a program changes around a nagging knee, a shoulder, a
    hamstring. What's a "train around it" vs. "stop and see somebody." What rules he writes into a
    program when an athlete reports pain.
12. **Testing and proof.** What he tests, how often, how he retests to prove a block worked, and
    what he does with the result.

## Then: the research list (do not skip this)

After the main territory, run a dedicated segment asking Joe **what you should go study**. This is
as important as everything above. Ask him, one at a time:

- Which training methodologies, systems, or schools of thought should WILCO's AI understand? Get
  names — the coaches, the books, the systems.
- For each one he names: what does he actually take from it, and what does he leave? Where is it
  right and where does it get misapplied?
- Which popular methods does he think are overrated or misused, and what's the failure mode when
  somebody runs them wrong?
- Who does he trust for youth and high-school athletes specifically — that population has different
  rules than the general strength world.
- What's the one thing most coaches get wrong that he'd want built into this app as a guardrail?
- Are there specific books, manuals, or certifications he'd want the doctrine to be consistent with?

Push for at least 6–10 named methodologies or sources with his take on each. You'll research these
afterward; his commentary is what makes the research useful, so capture it verbatim.

## What to produce at the end

After the interview, write these files. Output them as clean markdown in your reply, clearly
separated, so they can be copied into the WILCO repo.

**1. `doctrine-core.md`** — target 2,000–3,000 words. The rules that apply to *every* program:
philosophy and non-negotiables, training-age tiers, block structure and sequencing, volume and
intensity rules, deload rules, exercise selection hierarchy, warm-up/cool-down standards, red-flag
protocols, and a "what makes it slop" section written as things to never do. Imperative voice.
Numbers everywhere possible. This gets loaded on every program-building call, so every sentence has
to earn its place — cut anything that's philosophy without an operational consequence.

**2. Topic files**, each 500–1,500 words, loaded only when relevant:
- `doctrine-inseason.md` — in-season rules, lifting around games and practice
- `doctrine-team.md` — programming for a group, tracks vs. scaling, the mixed-room problem
- `doctrine-youth.md` — beginners and young athletes, hard limits
- `doctrine-conditioning.md` — conditioning, breaks, holiday and no-equipment situations
- `doctrine-return.md` — training around injuries, return-to-train progressions

**3. `doctrine-research-list.md`** — the methodologies and sources Joe named, each with his verbatim
take (what to borrow, what to skip, how it fails when misapplied), ordered by how much he'd want
WILCO to lean on it.

**4. A short `open-questions.md`** — anything he skipped, anything where his answer felt uncertain,
and anything you think needs a second pass. Be honest here; a gap you flag is cheaper than a gap the
app discovers in front of a customer.

## One more thing

At the very end, ask him this: *"If an athlete followed a program you wrote for eight weeks and it
didn't work, what would you look at first?"* — and write his answer into `doctrine-core.md` as its
own section. That answer is the debugging logic for every program the app will ever write.

Start by introducing yourself briefly, telling him roughly how long this will take and what you're
building, and asking your first question.
