-- ============================================================
-- PLU ARMY — Schema (single file, always current)
-- Run in Supabase: SQL Editor -> New Query -> paste all -> Run
--
-- This is the ONLY schema file for this project. Whenever
-- something needs to change, this file gets updated in place —
-- there are no separate patch files to track or re-apply.
--
-- This REPLACES the old schema entirely. It drops the existing
-- tables and all their data (messages, photos, accounts) AND every
-- Supabase Auth login, and rebuilds everything from a clean slate.
-- Running this file always means everyone re-registers from scratch
-- afterward — including you.
--
-- BEFORE running this, also do the one-time dashboard steps in
-- SUPABASE_AUTH_SETUP.md — this SQL alone is not enough, login
-- won't work until that's done too.
-- ============================================================

-- ============================
-- 0. CLEAN SLATE
-- ============================
-- Wipes ALL existing app data AND logins — messages, photos,
-- accounts, and the Supabase Auth logins behind them. Every time
-- this file is run, you start completely fresh: nobody can be left
-- with a login that has no matching profile (the "Account found,
-- but no profile on file" error), because logins and profiles are
-- always wiped together, in the same run.
--
-- This means: after running this file, EVERYONE — including you —
-- has to register again from scratch through index.html. There is
-- no way to preserve old accounts across a run of this file.

drop table if exists reports cascade;
drop table if exists replies cascade;
drop table if exists posts cascade;
drop table if exists users cascade;

-- Deletes every login Supabase Auth knows about (cascades to their
-- sessions/identities automatically). Safe even on a brand new
-- project where this is already empty.
delete from auth.users;

-- ============================
-- 1. TABLES
-- ============================

-- Profile info for each logged-in account. The id is NOT
-- generated here — it's always the same id Supabase Auth
-- assigned when the person signed up, which is how the database
-- knows "this row belongs to whoever is currently logged in."
create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  phone text not null unique,
  location text,
  is_active boolean not null default true,
  is_admin boolean not null default false,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null check (type in ('text', 'audio', 'image')),
  content text,          -- text content, or file URL for audio/image
  is_pinned boolean not null default false,   -- admin announcements
  is_deleted boolean not null default false,  -- soft delete by admin/owner
  is_edited boolean not null default false,
  reply_to uuid references posts(id) on delete set null,
  mentioned_user_ids uuid[] not null default '{}', -- who was @mentioned, for push notifications
  created_at timestamptz not null default now()
);

create table replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  reported_by uuid not null references users(id) on delete cascade,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);

-- ============================
-- 2. INDEXES
-- ============================

create index idx_posts_created_at on posts(created_at desc);
create index idx_replies_post_id on replies(post_id);
create index idx_reports_status on reports(status);

-- ============================
-- 3. HELPERS: "is the currently logged-in person an admin / active?"
-- ============================
-- Used throughout the policies below instead of repeating the same
-- subquery everywhere. security definer + a fixed search_path so
-- they reliably read the users table regardless of who calls them.

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select is_admin from users where id = auth.uid()),
    false
  );
$$;

-- Deactivation is a real, database-level lock, not just something
-- the app's screen shows — every insert/update policy below (and
-- every read policy) checks this, so a deactivated account can
-- neither write anything nor read anything once it takes effect.
create or replace function public.is_active_user()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select is_active from users where id = auth.uid()),
    false
  );
$$;

-- ============================
-- 4. GUARD TRIGGERS
-- ============================
-- Row-level security controls WHICH ROWS you can touch, but not
-- which COLUMNS within an allowed row. These two triggers close
-- that gap: they silently snap sensitive fields back to their old
-- value unless the person making the change is actually allowed
-- to change that field, no matter what the request body says.

-- Nobody can flip their own is_admin/is_active — only an admin
-- editing someone ELSE's row can do that. (admin.html also warns
-- before even trying, so this never has to silently no-op there —
-- but the trigger is the real, non-bypassable enforcement.)
create or replace function public.guard_user_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() = old.id then
    new.is_admin := old.is_admin;
    new.is_active := old.is_active;
  end if;
  return new;
end;
$$;

create trigger trg_guard_user_fields
before update on users
for each row execute function public.guard_user_fields();

-- Only an admin can pin a post — whether they're editing an existing
-- one OR creating a brand new one. The app's own UI never sends
-- is_pinned on a normal member's post, but without this trigger
-- covering INSERT too, nothing stops someone from calling the
-- Supabase API directly with their own login and pinning their own
-- post the moment they create it. Covering both INSERT and UPDATE
-- closes that gap; TG_OP tells us which one we're in, since there's
-- no "old" row yet to fall back to on an insert.
create or replace function public.guard_post_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if TG_OP = 'INSERT' then
      new.is_pinned := false;
    else
      new.is_pinned := old.is_pinned;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_guard_post_fields
before insert or update on posts
for each row execute function public.guard_post_fields();

-- ============================
-- 5. ROW LEVEL SECURITY
-- ============================

alter table users enable row level security;
alter table posts enable row level security;
alter table replies enable row level security;
alter table reports enable row level security;

-- USERS
-- A deactivated person can still read their OWN row (needed so the
-- app can see is_active = false and sign them out) but nobody else's.
-- Active members and admins can read everyone's basic profile info
-- (names/avatars need to show in the chat).
create policy "active users can read profiles" on users
  for select using (
    auth.uid() = id or public.is_active_user() or public.is_admin()
  );

create policy "you can create only your own profile" on users
  for insert with check (auth.uid() = id);

create policy "you or an admin can update a profile" on users
  for update
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

-- POSTS
-- Must be active (or admin) to read anything at all. Active users
-- see all non-deleted posts, plus their own deleted ones; admins
-- see everything regardless. Deactivated non-admins see nothing.
create policy "visible posts are readable by everyone" on posts
  for select using (
    ((is_deleted = false or auth.uid() = user_id) and public.is_active_user())
    or public.is_admin()
  );

create policy "you can only post as yourself" on posts
  for insert with check (auth.uid() = user_id and public.is_active_user());

create policy "you or an admin can update a post" on posts
  for update
  using ((auth.uid() = user_id and public.is_active_user()) or public.is_admin())
  with check ((auth.uid() = user_id and public.is_active_user()) or public.is_admin());

-- REPLIES (legacy table, kept for compatibility — the app
-- currently threads replies via posts.reply_to instead)
create policy "active users can read replies" on replies
  for select using (public.is_active_user() or public.is_admin());

create policy "you can only reply as yourself" on replies
  for insert with check (auth.uid() = user_id and public.is_active_user());

-- REPORTS
-- Only admins can see the reports queue — who reported what is
-- moderation-sensitive, not something every member should read.
create policy "only admins can read reports" on reports
  for select using (public.is_admin());

create policy "you can only file a report as yourself" on reports
  for insert with check (auth.uid() = reported_by and public.is_active_user());

create policy "only admins can update reports" on reports
  for update using (public.is_admin());

-- ============================
-- 6. STORAGE (post-media bucket)
-- ============================
-- Creates the bucket itself, not just its policies — on a brand
-- new project there is no manual "create a bucket in the
-- dashboard" step to remember; this file is enough on its own.
-- public: true means uploaded files are reachable by their URL
-- without a signed link, matching "anyone can view media" below.

insert into storage.buckets (id, name, public)
values ('post-media', 'post-media', true)
on conflict (id) do nothing;

drop policy if exists "public can upload media" on storage.objects;
drop policy if exists "public can read media" on storage.objects;
drop policy if exists "only logged-in users can upload media" on storage.objects;
drop policy if exists "anyone can view media" on storage.objects;

create policy "only logged-in users can upload media"
on storage.objects for insert
with check (bucket_id = 'post-media' and auth.role() = 'authenticated');

create policy "anyone can view media"
on storage.objects for select
using (bucket_id = 'post-media');

-- ============================
-- 6.5. PUSH SUBSCRIPTIONS (for @mention notifications)
-- ============================
-- One row per device someone has opted in to notifications on. The
-- Edge Function that sends notifications (deployed separately, not
-- part of this SQL file) reads across everyone's subscriptions using
-- its own elevated key, which is expected to bypass the RLS below —
-- that key is never exposed to the app itself.

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);

alter table push_subscriptions enable row level security;

create policy "you can register your own push subscription" on push_subscriptions
  for insert with check (auth.uid() = user_id and public.is_active_user());

create policy "you can read your own push subscriptions" on push_subscriptions
  for select using (auth.uid() = user_id);

create policy "you can remove your own push subscription" on push_subscriptions
  for delete using (auth.uid() = user_id);

-- ============================
-- 7. REALTIME
-- ============================
-- 'users' is included so the app's live "you've been deactivated"
-- listener (setupSelfStatusMonitor in index.html) actually receives
-- the update the instant an admin deactivates someone, instead of
-- listening to a stream that was never switched on.

alter publication supabase_realtime add table posts;
alter publication supabase_realtime add table users;

-- ============================
-- 8. AUTO-CLEANUP (90-day message expiry)
-- ============================
-- Runs once a day on its own, no dashboard steps needed beyond having
-- pg_cron available (enabled automatically below). Permanently deletes
-- any message older than 90 days, along with:
--   - its replies and any reports filed against it (handled
--     automatically — those tables already cascade-delete when their
--     post is removed, see section 1)
--   - its uploaded photo or voice note file in Storage, deleted here
--     explicitly since Storage files don't auto-delete on their own.
--     (Profile avatars live under a separate avatars/ path and are
--     never touched by this — only post media is time-limited.)

create extension if not exists pg_cron;

create or replace function public.delete_old_posts()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Remove the media file first, while the post row (and therefore its
  -- content) still exists to read the file's path from. For image/audio
  -- posts, `content` is a JSON string like {"url":"...","caption":"..."}
  -- (not a bare URL — the app stores the caption alongside it), so the
  -- URL has to be pulled out of the JSON with ->>'url' before the
  -- storage path can be extracted from it. Extracting it as if content
  -- were the raw URL (as an earlier version of this did) silently
  -- matched nothing, since no real object name ends with the leftover
  -- JSON text that approach left stuck on the end.
  delete from storage.objects
  where bucket_id = 'post-media'
    and name in (
      select regexp_replace(content::json->>'url', '^.*/post-media/', '')
      from posts
      where type in ('image', 'audio')
        and content is not null
        and created_at < now() - interval '90 days'
    );

  delete from posts
  where created_at < now() - interval '90 days';
end;
$$;

-- Safe to re-run: drops any existing schedule with this name first, so
-- running schema.sql again later never creates a second duplicate job.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'delete-old-posts-daily') then
    perform cron.unschedule('delete-old-posts-daily');
  end if;
end $$;

select cron.schedule(
  'delete-old-posts-daily',
  '0 3 * * *',  -- 03:00 UTC every day
  $$select public.delete_old_posts();$$
);

-- ============================
-- 9. SEED YOUR OWN ADMIN ACCOUNT
-- ============================
-- Do this AFTER completing SUPABASE_AUTH_SETUP.md and after you've
-- registered your own account through the app once (as a normal
-- member, name: Byereta Samuel, phone: 0779477048).
--
-- IMPORTANT: run ONLY the single line below by itself in SQL
-- Editor at that point — do NOT re-run this whole file again to
-- reach it, since section 0 would wipe the registration you just
-- did (and everyone else's) right back out.

update users set is_admin = true where phone = '256779477048';
