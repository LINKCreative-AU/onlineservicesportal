-- Registration Office portal — run once in the PORTAL Supabase project's SQL
-- editor (the shared ARO project is fine). Service-role access only; the
-- browser never talks to Supabase directly.

create table public.portal_users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  email text not null unique,
  full_name text not null,
  role text not null default 'team' check (role in ('admin','team')),
  pass_hash text not null,
  pass_salt text not null,
  must_change_password boolean not null default true,
  last_login_at timestamptz
);

-- Pipeline overlay per lead. The sites' own tables are never written to.
create table public.portal_lead_state (
  site text not null,
  lead_id text not null,
  status text not null default 'new'
    check (status in ('new','in_progress','lodged','cleared','refunded','dead')),
  assignee_email text,
  assignee_name text,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (site, lead_id)
);

-- Append-only audit trail; volume stats are computed from this.
create table public.portal_lead_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  site text not null,
  lead_id text not null,
  actor_email text not null,
  actor_name text,
  event text not null,          -- 'assigned' | 'status:<x>' | 'note'
  detail text
);
create index portal_lead_events_lead on public.portal_lead_events (site, lead_id, created_at desc);
create index portal_lead_events_time on public.portal_lead_events (created_at desc);

alter table public.portal_users enable row level security;
alter table public.portal_lead_state enable row level security;
alter table public.portal_lead_events enable row level security;
-- no anon policies on any portal table: service-role only (bypasses RLS)
