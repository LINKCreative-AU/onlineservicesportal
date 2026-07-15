-- Tax invoices + human-friendly order numbers. Run once; safe to re-run.
-- Sequences start at 20001 as a placeholder — once Juan exports the old
-- WooCommerce orders we can setval() them to continue the old numbering.

create table if not exists public.portal_invoices (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  site text not null,
  order_id text not null,
  invoice_no text unique,
  email text not null,
  name text,
  amount_cents integer not null,
  gst_cents integer not null,
  description text,
  sent_at timestamptz,
  unique (site, order_id)
);
alter table public.portal_invoices enable row level security;

-- ---------------------------------------------------------------- order refs
alter table public.abn_orders add column if not exists order_ref text;
alter table public.gst_orders add column if not exists order_ref text;
alter table public.claims     add column if not exists order_ref text;

create sequence if not exists abn_order_ref_seq start 20001;
create sequence if not exists gst_order_ref_seq start 20001;
create sequence if not exists dasp_order_ref_seq start 20001;

create or replace function public.set_abn_order_ref() returns trigger language plpgsql as $$
begin
  if new.order_ref is null then
    new.order_ref := (case new.service_type
      when 'registration' then 'ABN' when 'reactivation' then 'ABNR'
      when 'cancellation' then 'ABNC' when 'continuation' then 'ABNK'
      when 'rideshare' then 'ABNU' when 'businessname' then 'BN'
      else 'ABN' end) || '-' || nextval('abn_order_ref_seq');
  end if;
  return new;
end $$;

create or replace function public.set_gst_order_ref() returns trigger language plpgsql as $$
begin
  if new.order_ref is null then
    new.order_ref := (case new.service_type
      when 'cancellation' then 'GSTC' when 'rideshare' then 'GSTU'
      else 'GST' end) || '-' || nextval('gst_order_ref_seq');
  end if;
  return new;
end $$;

create or replace function public.set_dasp_order_ref() returns trigger language plpgsql as $$
begin
  if new.order_ref is null then
    new.order_ref := 'DASP-' || nextval('dasp_order_ref_seq');
  end if;
  return new;
end $$;

drop trigger if exists abn_order_ref on public.abn_orders;
create trigger abn_order_ref before insert on public.abn_orders for each row execute function public.set_abn_order_ref();
drop trigger if exists gst_order_ref on public.gst_orders;
create trigger gst_order_ref before insert on public.gst_orders for each row execute function public.set_gst_order_ref();
drop trigger if exists dasp_order_ref on public.claims;
create trigger dasp_order_ref before insert on public.claims for each row execute function public.set_dasp_order_ref();

-- backfill refs for existing rows (oldest first, so numbering follows arrival)
update public.abn_orders set order_ref = (case service_type
  when 'registration' then 'ABN' when 'reactivation' then 'ABNR' when 'cancellation' then 'ABNC'
  when 'continuation' then 'ABNK' when 'rideshare' then 'ABNU' when 'businessname' then 'BN' else 'ABN' end)
  || '-' || nextval('abn_order_ref_seq') where order_ref is null;
update public.gst_orders set order_ref = (case service_type
  when 'cancellation' then 'GSTC' when 'rideshare' then 'GSTU' else 'GST' end)
  || '-' || nextval('gst_order_ref_seq') where order_ref is null;
update public.claims set order_ref = 'DASP-' || nextval('dasp_order_ref_seq') where order_ref is null;
