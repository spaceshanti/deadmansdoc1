-- The Handover: prototype schema.
-- This stores what the interview collects. It deliberately does NOT store a
-- generated document -- that is the job of a later agent that reads this data.
--
-- Prototype note: this schema has no encryption-at-rest or field-level access
-- control implemented. See SECURITY_NOTES.md for what a real deployment needs
-- before any non-synthetic data touches it (this includes the "visibility"
-- column on facts, which is captured now but not yet enforced).

create extension if not exists "pgcrypto";

create table if not exists records (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('self', 'parent')),
  subject_name text,
  initiator_relationship text, -- e.g. "daughter" -- only meaningful when mode = 'parent'
  resume_code text not null unique,
  status text not null default 'in_progress' check (status in ('in_progress', 'paused', 'complete')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references records(id) on delete cascade,
  who_is_present text,
  consent_given boolean not null default false,
  started_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  record_id uuid not null references records(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null,
  tool_name text,
  created_at timestamptz not null default now()
);

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references records(id) on delete cascade,
  name text not null,
  relationship text,
  roles text[] not null default '{}', -- e.g. {executor, financial_advisor}
  scope_of_authority text,
  what_they_hold_or_oversee text,
  contact_details jsonb not null default '{}',
  is_reachable boolean,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists facts (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references records(id) on delete cascade,
  category text not null,
  label text not null,
  value text not null,
  notes text,
  family_action text, -- what the family will actually need to do about this, if anything (this is the point of the whole record: not just what's true, but what someone who's never touched it will have to handle)
  confidence text not null default 'stated' check (confidence in ('stated', 'uncertain', 'inferred')),
  source text not null default 'self' check (source in ('self', 'parent', 'other')),
  visibility text not null default 'family' check (visibility in ('family', 'executor_only', 'after_death_only')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (record_id, category, label)
);

create table if not exists gaps (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references records(id) on delete cascade,
  category text not null,
  description text not null,
  who_would_know text,
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Every time an interview turn fails (LLM error, rate limit, malformed tool
-- call, etc), independent of whatever error message the user was shown --
-- for diagnosing issues after the fact, not shown to end users.
create table if not exists error_logs (
  id uuid primary key default gen_random_uuid(),
  record_id uuid references records(id) on delete set null,
  session_id uuid references sessions(id) on delete set null,
  context text not null,
  error_type text not null default 'unknown', -- e.g. rate_limit, service_unavailable, auth, network_error, tool_schema_error
  status_code integer, -- HTTP status from the provider, when there was one
  provider text, -- LLM_BASE_URL at the time of the error
  model text, -- LLM_MODEL at the time of the error
  duration_ms integer, -- how long the failed turn took before erroring
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sessions_record on sessions(record_id);
create index if not exists idx_messages_session on messages(session_id);
create index if not exists idx_people_record on people(record_id);
create index if not exists idx_facts_record on facts(record_id);
create index if not exists idx_gaps_record on gaps(record_id);
create index if not exists idx_error_logs_created on error_logs(created_at desc);

-- Additive migration for databases created before family_action existed.
alter table facts add column if not exists family_action text;

-- Additive migration for databases created before error_logs was detailed.
-- Must run before idx_error_logs_type below, since that column may not
-- exist yet on a database that already had error_logs from before.
alter table error_logs add column if not exists error_type text not null default 'unknown';
alter table error_logs add column if not exists status_code integer;
alter table error_logs add column if not exists provider text;
alter table error_logs add column if not exists model text;
alter table error_logs add column if not exists duration_ms integer;

create index if not exists idx_error_logs_type on error_logs(error_type);

-- Additive migration for databases with people rows from before upserting
-- existed: repeated save_person calls for the same person previously
-- created a new row every time (no conflict target to update instead), so
-- real records have several duplicate rows per person. Keep the most
-- recently updated row per (record_id, name) and drop the rest before the
-- unique index below is added -- creating it against still-duplicated data
-- would fail outright.
delete from people p
using people p2
where p.record_id = p2.record_id
  and lower(p.name) = lower(p2.name)
  and (p2.updated_at, p2.id) > (p.updated_at, p.id);

-- Case-insensitive per record: repeated save_person calls for the same
-- person (which happen routinely -- the model re-confirms someone almost
-- every turn) now update this row instead of creating a new one.
create unique index if not exists idx_people_record_name_unique on people (record_id, lower(name));
