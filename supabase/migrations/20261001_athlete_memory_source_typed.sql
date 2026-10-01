-- T69-A (Will 10-01): the athlete edits memory text directly on the Memory tab.
-- A fact they typed with their own hands is marked source = 'athlete_typed', so
-- it can be told apart from a fact Joe wrote from something they said
-- ('athlete_said') and one the app inferred ('inferred'). Additive: the two
-- existing values stay valid, no row changes.
-- Gateway twin: api/data.js ATHLETE_COL_ALLOW.athlete_memory.values.source.
-- Client constant: src/memoryEdit.js TYPED_SOURCE.
ALTER TABLE public.athlete_memory DROP CONSTRAINT athlete_memory_source_check;
ALTER TABLE public.athlete_memory ADD CONSTRAINT athlete_memory_source_check
  CHECK (source = ANY (ARRAY['athlete_said'::text, 'inferred'::text, 'athlete_typed'::text]));
