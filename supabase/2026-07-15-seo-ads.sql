-- SEO snapshots + external connections (Google Ads OAuth). Run once in the
-- same Supabase project as portal-schema.sql. Safe to re-run.

create table if not exists public.portal_seo_snapshots (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  site text not null,
  data jsonb not null
);
create index if not exists portal_seo_snap_site on public.portal_seo_snapshots (site, created_at desc);

create table if not exists public.portal_connections (
  id text primary key,               -- e.g. 'google_ads'
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.portal_seo_snapshots enable row level security;
alter table public.portal_connections enable row level security;
-- service-role only (bypasses RLS); no anon policies
