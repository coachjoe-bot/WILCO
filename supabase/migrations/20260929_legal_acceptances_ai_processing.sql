alter table public.legal_acceptances drop constraint legal_acceptances_document_check;
alter table public.legal_acceptances add constraint legal_acceptances_document_check
  check (document = any (array['terms'::text, 'privacy'::text, 'parental_consent'::text, 'ai_processing'::text]));
alter function public.crew_edges_block_org_compare() set search_path = public, pg_temp;
