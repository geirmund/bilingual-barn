-- Wick Timesheet: database schema for Supabase.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per person. Created automatically when a user is added in Auth.
create table if not exists public.profiles (
  id                  uuid primary key references auth.users on delete cascade,
  full_name           text not null default '',
  email               text not null default '',
  address             text not null default '',
  bank_details        text not null default '',
  day_rate            numeric(10,2) not null default 0,
  invoice_prefix      text not null default 'INV-',
  next_invoice_number integer not null default 1,
  created_at          timestamptz not null default now()
);

-- Shared settings (single row): who we invoice and on what terms.
create table if not exists public.settings (
  id                 integer primary key default 1 check (id = 1),
  client_name        text not null default 'Wick Award',
  client_address     text not null default '',
  payment_terms_days integer not null default 30,
  invoice_notes      text not null default ''
);
insert into public.settings (id) values (1) on conflict do nothing;

create table if not exists public.projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text not null default '',   -- grant / budget reference
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references public.profiles on delete cascade,
  kind         text not null default 'invoice' check (kind in ('invoice', 'claim')),
  number       text not null,
  issued_on    date not null default current_date,
  period_start date not null,
  period_end   date not null,
  total        numeric(12,2) not null default 0,
  data         jsonb not null,                 -- frozen snapshot of the lines
  created_at   timestamptz not null default now(),
  unique (user_id, number)
);

create table if not exists public.time_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles on delete cascade,
  project_id  uuid not null references public.projects,
  work_date   date not null,
  days        numeric(4,2) not null check (days > 0 and days <= 2),
  description text not null default '',
  invoice_id  uuid references public.invoices on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references public.profiles on delete cascade,
  project_id   uuid not null references public.projects,
  spent_on     date not null,
  description  text not null default '',
  category     text not null default 'Other',
  amount       numeric(10,2) not null check (amount >= 0),
  receipt_path text,
  receipt_name text,
  invoice_id   uuid references public.invoices on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists time_entries_user_date on public.time_entries (user_id, work_date);
create index if not exists expenses_user_date on public.expenses (user_id, spent_on);

-- ---------------------------------------------------------------------------
-- Create a profile whenever a user is added
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), split_part(coalesce(new.email, ''), '@', 1))
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for users created before this script ran.
insert into public.profiles (id, email, full_name)
select id, coalesce(email, ''), split_part(coalesce(email, ''), '@', 1) from auth.users
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Row level security: both people can see everything; each person can only
-- change their own time, expenses, invoices and profile.
-- ---------------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.settings     enable row level security;
alter table public.projects     enable row level security;
alter table public.invoices     enable row level security;
alter table public.time_entries enable row level security;
alter table public.expenses     enable row level security;

drop policy if exists "read" on public.profiles;
drop policy if exists "own" on public.profiles;
create policy "read" on public.profiles for select to authenticated using (true);
create policy "own"  on public.profiles for update to authenticated using (id = auth.uid());

drop policy if exists "all" on public.settings;
create policy "all" on public.settings for all to authenticated using (true) with check (true);

drop policy if exists "all" on public.projects;
create policy "all" on public.projects for all to authenticated using (true) with check (true);

do $$
declare t text;
begin
  foreach t in array array['invoices', 'time_entries', 'expenses'] loop
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "own" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "own" on public.%I for all to authenticated
                    using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Private storage bucket for receipts. Files live under <user id>/...
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "receipts read" on storage.objects;
drop policy if exists "receipts write own" on storage.objects;
drop policy if exists "receipts delete own" on storage.objects;
create policy "receipts read" on storage.objects for select to authenticated
  using (bucket_id = 'receipts');
create policy "receipts write own" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "receipts delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
