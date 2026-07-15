-- Phase 2: session tracking + usage reports. Run once; safe to re-run.

create table if not exists public.portal_usage_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  site text not null,
  session_id text not null,
  device text,
  type text not null,       -- pageview | click | form_start | field_focus | form_submit | scroll | jserror | end
  path text,
  detail jsonb
);
create index if not exists usage_events_site_time on public.portal_usage_events (site, created_at desc);
create index if not exists usage_events_session on public.portal_usage_events (session_id);

create table if not exists public.portal_usage_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  period text not null,        -- daily | weekly | monthly
  period_start date not null,
  data jsonb not null
);
create index if not exists usage_reports_period on public.portal_usage_reports (period, period_start desc);

alter table public.portal_usage_events enable row level security;
alter table public.portal_usage_reports enable row level security;
-- service-role only (bypasses RLS); no anon policies
