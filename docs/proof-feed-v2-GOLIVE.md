# Proof Feed v2 — Go-Live Checklist (for Will)

> **STATUS: ✅ LIVE on app.trainwilco.com since 2026-06-26.** All six phases
> deployed (`main`), migration applied, pg_cron scheduled, run-now verified
> end-to-end (digest generated, Sonnet call ok, cost logged, Step 5 clean). The
> checklist below is kept as a record + reference. For the current architecture and
> "where to tweak," see the `project-wilco-proof-feed-v2` memory note.
>
> **Deviations from the plan worth remembering:**
> - **pg_cron secret:** Supabase rejected `ALTER DATABASE postgres SET app.*`
>   (error 42501), so the engine URL + `CRON_SECRET` are **hardcoded inside the two
>   `proof_feed_dispatch_*` SQL functions** (not `current_setting`). Rotating
>   `CRON_SECRET` ⇒ update the Vercel env var **and** re-run those two functions.
> - **proof_digests.athlete_id** was `NOT NULL`; the migration drops that so
>   team-aggregate coach reports (null athlete_id) can be inserted.
> - Post-launch fixes (all live): run-now refreshes the Proof tab; digest loads even
>   when restoring today's cached chat; the check-in answers clarifying questions
>   (one follow-up each); check-in is once per report (`content_json.checkin_done`);
>   injury question + plan share one focus and state the concrete change.
>
> **Future minor tweaks:** digest prose → `api/_proof.js` (`COACH_VOICE` + each
> generator's `system` string); questions → `buildQuestionBank()` /
> `monthlyExtraQuestions()` there; schedule cadence → the two cron jobs.

Original step-by-step (each was safe; app kept working between them — the feature
was dormant until the engine ran):

---

## 1. Review the diff (optional but recommended)
```
cd ~/dev/WILCO
git checkout feature/proof-feed-v2
git log --oneline main..HEAD     # 7 commits, one per phase + a fix
git diff main..HEAD --stat
```

## 2. Apply the two migrations (Supabase SQL Editor)
Run, in this order:
1. `supabase/migrations/20260625_proof_feed_v2.sql` — adds athlete scheduling
   columns, `program_prescriptions` (RLS server-only), widens the digest_type
   CHECK, makes `proof_digests.athlete_id` nullable (coach reports), adds a scale
   index. Idempotent.
2. **Hold** on `20260625_proof_feed_v2_cron.sql` until step 5 (it needs the URL +
   secret set first, and the code deployed).

**Quick check after #1:**
```sql
select column_name from information_schema.columns
 where table_name='athletes' and column_name in
 ('proof_enabled','proof_schedule_dow','proof_schedule_hour','proof_timezone','last_proof_run_date','ask_weight');
-- expect 6 rows
select 1 from information_schema.tables where table_name='program_prescriptions'; -- expect 1
```

## 3. Confirm/Set environment (Vercel → fortis → Settings → Environment Variables)
Already set (verified in code use): `ANTHROPIC_KEY`, `SUPABASE_SERVICE_KEY`,
`RESEND_API_KEY`, `FROM_EMAIL`, `CRON_SECRET`, `SUPABASE_URL`/`VITE_SUPABASE_URL`.
- `APP_URL` — **optional**; defaults to `https://app.trainwilco.com` in code. Only
  set it if that domain ever changes.

## 4. Deploy
```
git checkout main && git merge --no-ff feature/proof-feed-v2
git push            # auto-deploys to fortis (app.trainwilco.com)
# or: keep on the branch and `vercel deploy` a preview first to smoke-test
```
Still **12/12** Vercel functions — no new function was added.

## 5. Wire pg_cron (Supabase SQL Editor)
First set the engine URL + cron secret as DB settings (replace the secret):
```sql
ALTER DATABASE postgres SET app.proof_engine_url  = 'https://app.trainwilco.com/api/trigger-proof-feed';
ALTER DATABASE postgres SET app.proof_cron_secret = '<the CRON_SECRET value from Vercel>';
```
Then run `supabase/migrations/20260625_proof_feed_v2_cron.sql`. Verify:
```sql
select jobname, schedule, active from cron.job where jobname like 'proof-feed-%';
```

## 6. Smoke-test end to end
- In the app (logged in as a test athlete): **Settings → Proof Feed → Run now**.
  Expect "Your Proof Feed is ready" (or the daily-cap message on a 2nd press).
- Open **My Log → Proof** — the digest card + sections render; tap to run the
  guided check-in; "Go deeper" reveals more questions then stops.
- Check the DB: `select digest_type,label from proof_digests order by generated_at desc limit 5;`
  and `select feature,model,input_tokens,output_tokens from usage_costs where feature like 'proof_%' order by created_at desc limit 5;`
- Coach login → **Reports** tab → the **TEAM REPORT** card opens the aggregate.

---

## Decisions / things to eyeball (no blockers — sensible defaults chosen)
- **`usage_costs.feature` CHECK** — if that column has a CHECK constraint, add the
  new labels (`proof_weekly`, `proof_monthly`, `proof_coach`, `program_parse`,
  `proof_answer_extract`) or cost logging silently no-ops (digests still work).
- **Digest prose quality** — generators are built to the spec's gold samples but
  tuned blind; review the first few real digests and adjust the prompts in
  `api/_proof.js` (`COACH_VOICE` + the per-generator system strings) if the voice
  is off. Models: Sonnet 4.6 for digests, Haiku 4.5 for program parse + answer
  extraction.
- **Coach cadence** — team reports fire Mondays 13:00 UTC (`proof-feed-coaches`
  job). Change the cron expression if you want a different day/time.
- **Backstop sweep** — the daily Vercel cron (`vercel.json`) still runs a full
  sweep as a safety net. Once pg_cron fanout is verified you can remove that one
  cron entry (the daily-cap makes a double-run harmless either way).
- **Program-week boundary** — adherence uses block start dates when the parsed
  program has them, else falls back to a 7-day window + block week 0. Good enough
  for launch; revisit if you want stricter program-week alignment.

## What changed (file map)
- `api/_supa.js` — `askClaudeServer()` (server AI + usage_costs), model param.
- `api/_proof.js` — NEW: brief, program parse, adherence, question bank, weekly/
  monthly/coach generators. (`_`-prefixed → not a Vercel function.)
- `api/trigger-proof-feed.js` — the engine: per-athlete + per-coach + run-now +
  sweep; daily cap; emails.
- `api/claude.js` — proof_* cost-feature labels.
- `api/data.js` — coach reads of proof_digests scoped by coach_id (team reports).
- `src/App.jsx` — `ProofChatModal` (weekly+monthly guided chat), proof-tab cards,
  coach team-report UI, Settings scheduling + Run now.
- `supabase/migrations/20260625_proof_feed_v2.sql` + `_cron.sql` — schema + pg_cron.
- deleted `supabase/functions/proof-feed-daily/`.
