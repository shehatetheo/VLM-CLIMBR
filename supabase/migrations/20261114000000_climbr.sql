-- CLIMBR · saved climbs, the community feed, and moderation.
-- Written for a Supabase project of its own (it creates public.profiles).
--
-- Safety rules this file enforces in the database, not in the app:
--   · a climb is private until its owner shares it, and a shared climb is shown
--     to nobody else until a moderator approves it (is_approved);
--   · users can only ever change their own rows, and of a climb only its
--     visibility and title: scores, analysis and approval are not theirs to edit;
--   · other people's props counts come back as a soft range, never a number;
--   · three reports hide a climb until it is reviewed;
--   · no location is stored anywhere: there is no column for it.

create extension if not exists pgcrypto with schema extensions;

-- ── tables ───────────────────────────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[A-Za-z0-9]{3,24}$'),
  theme text not null default 'lime' check (theme in ('lime', 'sunset', 'midnight')),
  created_at timestamptz not null default now()
);

create table public.climbs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null default 'climb' check (char_length(title) between 1 and 60),
  video_path text not null,
  thumbnail_path text,
  duration real not null default 0,
  route_color text not null,
  hold_count integer not null default 0,
  status text not null check (status in ('sent', 'unfinished', 'unclear')),
  coach_score integer not null check (coach_score between 0 and 100),
  sub_scores jsonb not null default '[]'::jsonb,
  analysis jsonb not null,
  highlight jsonb,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  is_approved boolean not null default false,
  is_example boolean not null default false,
  hidden_at timestamptz, -- set when reports hide it, cleared on review
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index climbs_feed_idx on public.climbs (created_at desc) where visibility = 'public' and is_approved and hidden_at is null;
create index climbs_user_idx on public.climbs (user_id, created_at desc);

create table public.props (
  user_id uuid not null references public.profiles (id) on delete cascade,
  climb_id uuid not null references public.climbs (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, climb_id)
);
create index props_climb_idx on public.props (climb_id);

create table public.saves (
  user_id uuid not null references public.profiles (id) on delete cascade,
  climb_id uuid not null references public.climbs (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, climb_id)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  climb_id uuid not null references public.climbs (id) on delete cascade,
  reason text not null check (reason in ('not_climbing', 'inappropriate', 'other')),
  created_at timestamptz not null default now(),
  unique (reporter_id, climb_id)
);
create index reports_climb_idx on public.reports (climb_id);

-- Settings no API role can read: limits, and the hash of the moderation secret.
create schema if not exists private;
create table private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values ('uploads_per_day', '20'), ('reports_to_hide', '3');
revoke all on schema private from anon, authenticated;

-- ── helpers ──────────────────────────────────────────────────────────────────
create function private.setting(p_key text) returns text language sql stable security definer set search_path = '' as
$$ select value from private.settings where key = p_key $$;

-- Is this request a signed-in API user (as opposed to SQL run by the owner,
-- or one of the security-definer functions below)?
create function private.is_api_user() returns boolean language sql stable set search_path = '' as
$$ select current_user in ('authenticated', 'anon') $$;

-- The upload limit, answered yes or no so the setting itself stays private.
create function private.under_daily_limit(p_user uuid) returns boolean language sql stable security definer set search_path = '' as
$$ select (select count(*) from public.climbs c where c.user_id = p_user and c.created_at > now() - interval '1 day') < (select value::int from private.settings where key = 'uploads_per_day') $$;

-- Other people's props are a soft range, so nobody chases a number.
create function public.props_band(n integer) returns text language sql immutable set search_path = '' as
$$ select case when n <= 0 then null when n < 5 then 'a few' when n < 10 then '5+' when n < 25 then '10+' when n < 50 then '25+' when n < 100 then '50+' else '100+' end $$;

-- ── guards ───────────────────────────────────────────────────────────────────
-- A user decides only whether their climb is private or public, and its title.
create function private.climbs_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if not private.is_api_user() then return new; end if;
  if tg_op = 'INSERT' then
    new.is_approved := false; new.is_example := false; new.hidden_at := null; new.reviewed_at := null; new.created_at := now();
    if not private.under_daily_limit(new.user_id) then
      raise exception 'daily_limit' using hint = 'Too many climbs saved today.';
    end if;
    return new;
  end if;
  new.id := old.id; new.user_id := old.user_id; new.video_path := old.video_path; new.thumbnail_path := old.thumbnail_path;
  new.duration := old.duration; new.route_color := old.route_color; new.hold_count := old.hold_count; new.status := old.status;
  new.coach_score := old.coach_score; new.sub_scores := old.sub_scores; new.analysis := old.analysis; new.highlight := old.highlight;
  new.is_approved := old.is_approved; new.is_example := old.is_example; new.hidden_at := old.hidden_at; new.reviewed_at := old.reviewed_at; new.created_at := old.created_at;
  -- A renamed climb has to be looked at again before it is public.
  if new.title is distinct from old.title then new.is_approved := false; new.reviewed_at := null; end if;
  return new;
end $$;
create trigger climbs_guard before insert or update on public.climbs for each row execute function private.climbs_guard();

-- ── row level security ───────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.climbs enable row level security;
alter table public.props enable row level security;
alter table public.saves enable row level security;
alter table public.reports enable row level security;

create policy "own profile: read" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile: create" on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy "own profile: update" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "climbs: own, or public and approved" on public.climbs for select to authenticated, anon
  using (user_id = (select auth.uid()) or (visibility = 'public' and is_approved and hidden_at is null));
create policy "climbs: create own" on public.climbs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "climbs: update own" on public.climbs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "climbs: delete own" on public.climbs for delete to authenticated using (user_id = (select auth.uid()));

create policy "props: read own" on public.props for select to authenticated using (user_id = (select auth.uid()));
create policy "props: give" on public.props for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.climbs c where c.id = climb_id and c.visibility = 'public' and c.is_approved and c.hidden_at is null));
create policy "props: take back" on public.props for delete to authenticated using (user_id = (select auth.uid()));

create policy "saves: read own" on public.saves for select to authenticated using (user_id = (select auth.uid()));
create policy "saves: add" on public.saves for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.climbs c where c.id = climb_id and c.visibility = 'public' and c.is_approved and c.hidden_at is null));
create policy "saves: remove" on public.saves for delete to authenticated using (user_id = (select auth.uid()));

create policy "reports: read own" on public.reports for select to authenticated using (reporter_id = (select auth.uid()));
-- Reports are filed through report_climb(), which also hides a climb at the limit.

-- ── the feed ─────────────────────────────────────────────────────────────────
create type public.climb_card as (
  id uuid, username text, title text, route_color text, hold_count integer, duration real, status text, coach_score integer,
  sub_scores jsonb, highlight jsonb, visibility text, is_approved boolean, is_example boolean, created_at timestamptz,
  video_path text, thumbnail_path text, mine boolean, propped boolean, saved boolean, props text
);

create function private.card(c public.climbs) returns public.climb_card language sql stable security definer set search_path = '' as $$
  select c.id, p.username, c.title, c.route_color, c.hold_count, c.duration, c.status, c.coach_score, c.sub_scores, c.highlight,
    c.visibility, c.is_approved, c.is_example, c.created_at, c.video_path, c.thumbnail_path,
    c.user_id = (select auth.uid()),
    exists (select 1 from public.props x where x.climb_id = c.id and x.user_id = (select auth.uid())),
    exists (select 1 from public.saves x where x.climb_id = c.id and x.user_id = (select auth.uid())),
    case when c.user_id = (select auth.uid()) then (select count(*)::text from public.props x where x.climb_id = c.id)
         else public.props_band((select count(*)::int from public.props x where x.climb_id = c.id)) end
  from public.profiles p where p.id = c.user_id
$$;

create function public.feed(p_cursor timestamptz default null, p_limit integer default 6, p_color text default null)
returns setof public.climb_card language sql stable security definer set search_path = '' as $$
  select (private.card(c)).* from public.climbs c
  where c.visibility = 'public' and c.is_approved and c.hidden_at is null
    and (p_cursor is null or c.created_at < p_cursor) and (p_color is null or c.route_color = p_color)
  order by c.created_at desc limit least(greatest(p_limit, 1), 20)
$$;

create function public.saved_feed(p_cursor timestamptz default null, p_limit integer default 6)
returns setof public.climb_card language sql stable security definer set search_path = '' as $$
  select (private.card(c)).* from public.saves s join public.climbs c on c.id = s.climb_id
  where s.user_id = (select auth.uid()) and c.visibility = 'public' and c.is_approved and c.hidden_at is null
    and (p_cursor is null or c.created_at < p_cursor)
  order by c.created_at desc limit least(greatest(p_limit, 1), 20)
$$;

create function public.my_climbs() returns setof public.climb_card language sql stable security definer set search_path = '' as $$
  select (private.card(c)).* from public.climbs c where c.user_id = (select auth.uid()) order by c.created_at desc limit 200
$$;

-- One climb with its analysis, for whoever is allowed to see it.
create function public.get_climb(p_id uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(private.card(c)) || jsonb_build_object('analysis', c.analysis) from public.climbs c
  where c.id = p_id and (c.user_id = (select auth.uid()) or (c.visibility = 'public' and c.is_approved and c.hidden_at is null))
$$;

-- File a report. At the limit the climb is hidden until a moderator looks at it.
create function public.report_climb(p_climb uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not signed in'; end if;
  insert into public.reports (reporter_id, climb_id, reason) values ((select auth.uid()), p_climb, p_reason) on conflict (reporter_id, climb_id) do nothing;
  if (select count(*) from public.reports r where r.climb_id = p_climb) >= private.setting('reports_to_hide')::int then
    update public.climbs set hidden_at = coalesce(hidden_at, now()) where id = p_climb and not is_example;
  end if;
end $$;

-- ── moderation ───────────────────────────────────────────────────────────────
-- The admin page never holds a key: its server function (api/admin) checks the
-- admin password, then calls these with a secret whose bcrypt hash lives in
-- private.settings. Set it once, from the SQL editor:
--   insert into private.settings (key, value) values ('admin_secret_hash', extensions.crypt('<ADMIN_RPC_SECRET>', extensions.gen_salt('bf')))
--   on conflict (key) do update set value = excluded.value;
create function private.admin_ok(p_secret text) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select value = extensions.crypt(p_secret, value) from private.settings where key = 'admin_secret_hash'), false)
$$;

create function public.admin_pending(p_secret text)
returns table (id uuid, title text, username text, status text, coach_score integer, reports integer, created_at timestamptz, video_path text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.admin_ok(p_secret) then raise exception 'forbidden'; end if;
  return query
    select c.id, c.title, p.username, c.status, c.coach_score, (select count(*)::int from public.reports r where r.climb_id = c.id), c.created_at, c.video_path
    from public.climbs c join public.profiles p on p.id = c.user_id
    where c.visibility = 'public' and ((not c.is_approved and c.reviewed_at is null) or c.hidden_at is not null)
    order by c.created_at asc limit 100;
end $$;

-- Approve: it goes into the feed. Reject: it goes back to private.
create function public.admin_review(p_secret text, p_id uuid, p_approve boolean) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.admin_ok(p_secret) then raise exception 'forbidden'; end if;
  if p_approve then
    update public.climbs set is_approved = true, hidden_at = null, reviewed_at = now() where id = p_id;
    delete from public.reports where climb_id = p_id;
  else
    update public.climbs set is_approved = false, visibility = 'private', hidden_at = null, reviewed_at = now() where id = p_id;
  end if;
end $$;

-- Used by the seed script: make a climb an official, approved example.
create function public.admin_mark_example(p_secret text, p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.admin_ok(p_secret) then raise exception 'forbidden'; end if;
  update public.climbs set is_example = true, is_approved = true, visibility = 'public', hidden_at = null, reviewed_at = now() where id = p_id;
  update public.profiles set username = 'CLIMBR' where id = (select user_id from public.climbs where id = p_id) and not exists (select 1 from public.profiles where username = 'CLIMBR');
end $$;

create function public.admin_clear_examples(p_secret text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.admin_ok(p_secret) then raise exception 'forbidden'; end if;
  delete from public.climbs where is_example;
end $$;

-- Without the app, from the SQL editor:
--   update public.climbs set is_approved = true, reviewed_at = now() where id = '<climb id>';                          -- approve
--   update public.climbs set is_approved = false, visibility = 'private', reviewed_at = now() where id = '<climb id>'; -- reject

revoke execute on all functions in schema private from public, anon, authenticated;
-- The guard trigger runs as the caller, so it needs these two; neither reveals a setting.
-- (The private schema is not exposed through the API, so nothing in it can be called from outside.)
grant usage on schema private to anon, authenticated;
grant execute on function private.is_api_user(), private.under_daily_limit(uuid) to anon, authenticated;
grant execute on function public.feed(timestamptz, integer, text), public.get_climb(uuid) to anon, authenticated;
grant execute on function public.saved_feed(timestamptz, integer), public.my_climbs(), public.report_climb(uuid, text) to authenticated;
grant execute on function public.admin_pending(text), public.admin_review(text, uuid, boolean), public.admin_mark_example(text, uuid), public.admin_clear_examples(text) to anon, authenticated;

-- ── storage ──────────────────────────────────────────────────────────────────
-- Private buckets, served with signed URLs. Objects live under the owner's id:
--   climb-videos/<user id>/<climb id>.mp4      climb-thumbnails/<user id>/<climb id>.jpg
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('climb-videos', 'climb-videos', false, 104857600, array['video/mp4', 'video/webm']),
  ('climb-thumbnails', 'climb-thumbnails', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- A file can be signed by its owner, or by anyone once its climb has been
-- shared. A shared-but-unapproved file is reachable only by its unguessable
-- path, which only the owner and the moderation queue ever learn.
create function public.climb_object_visible(p_name text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.climbs c where (c.video_path = p_name or c.thumbnail_path = p_name) and c.visibility = 'public')
$$;
grant execute on function public.climb_object_visible(text) to anon, authenticated;

create policy "climb files: upload own" on storage.objects for insert to authenticated
  with check (bucket_id in ('climb-videos', 'climb-thumbnails') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "climb files: read own or shared" on storage.objects for select to authenticated, anon
  using (bucket_id in ('climb-videos', 'climb-thumbnails') and ((storage.foldername(name))[1] = (select auth.uid())::text or public.climb_object_visible(name)));
create policy "climb files: replace own" on storage.objects for update to authenticated
  using (bucket_id in ('climb-videos', 'climb-thumbnails') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "climb files: delete own" on storage.objects for delete to authenticated
  using (bucket_id in ('climb-videos', 'climb-thumbnails') and (storage.foldername(name))[1] = (select auth.uid())::text);
