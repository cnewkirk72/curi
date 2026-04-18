-- Security hardening: pin search_path on set_updated_at().
-- Fixes the `function_search_path_mutable` advisory from Supabase's linter.
-- See https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
