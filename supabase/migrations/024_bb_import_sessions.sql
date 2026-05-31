-- Bank Book import sessions: persist the full match result so the split view
-- survives page refresh, tab switches, and rule-confirm clicks.
create table if not exists bb_import_sessions (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null,
  client_id       uuid        not null,
  financial_year  text        not null default '',
  result_json     jsonb       not null,
  bb_filename     text,
  stmt_filenames  text[],
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  confirmed_at    timestamptz,
  unique(tenant_id, client_id, financial_year)
);

alter table bb_import_sessions enable row level security;

create policy "tenant_rls" on bb_import_sessions
  for all
  using (tenant_id = (select tenant_id from users where id = auth.uid()));
