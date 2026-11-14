-- Security tests for the CLIMBR schema. Every line prints PASS or FAIL.
\set ON_ERROR_STOP off
\pset tuples_only on
\pset format unaligned
create or replace function pg_temp.check_(label text, ok boolean) returns text language sql as $$ select case when ok then 'PASS  ' else 'FAIL  ' end || label $$;
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b'), ('00000000-0000-0000-0000-00000000000c'), ('00000000-0000-0000-0000-00000000000d');
insert into private.settings (key, value) values ('admin_secret_hash', extensions.crypt('s3cret', extensions.gen_salt('bf')));
-- Most checks run with moderation on, the strict mode; the default (auto-approve) is checked at the end.
update private.settings set value = 'false' where key = 'auto_approve';

-- A signs in, makes a profile and a climb, and tries to approve it herself.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
insert into public.profiles (id, username) values (auth.uid(), 'CrimpyGecko42');
insert into public.climbs (id, user_id, title, video_path, thumbnail_path, route_color, status, coach_score, analysis, is_approved, is_example, visibility)
  values ('10000000-0000-0000-0000-000000000001', auth.uid(), 'green slab', '00000000-0000-0000-0000-00000000000a/v1.mp4', '00000000-0000-0000-0000-00000000000a/v1.jpg', 'green', 'sent', 82, '{"holds":[]}', true, true, 'public');
select pg_temp.check_('a new climb cannot approve itself or call itself an example', not is_approved and not is_example) from public.climbs where id = '10000000-0000-0000-0000-000000000001';
update public.climbs set coach_score = 100, is_approved = true, analysis = '{"hacked":true}' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.check_('an owner cannot edit the score, the analysis or the approval', coach_score = 82 and not is_approved and analysis = '{"holds":[]}') from public.climbs where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.check_('an owner sees her own unapproved climb', count(*) = 1) from public.climbs;
select pg_temp.check_('the owner sees it in my_climbs()', count(*) = 1) from public.my_climbs();

-- B cannot see it, prop it, edit it or delete it while it is unapproved.
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
insert into public.profiles (id, username) values (auth.uid(), 'SendyOtter17');
select pg_temp.check_('someone else cannot see a shared but unapproved climb', count(*) = 0) from public.climbs;
select pg_temp.check_('feed() leaves it out', count(*) = 0) from public.feed();
select pg_temp.check_('get_climb() returns nothing for it', public.get_climb('10000000-0000-0000-0000-000000000001') is null);
do $$ begin insert into public.props (user_id, climb_id) values (auth.uid(), '10000000-0000-0000-0000-000000000001'); raise notice 'FAIL  props on an unapproved climb are refused'; exception when others then raise notice 'PASS  props on an unapproved climb are refused'; end $$;
update public.climbs set title = 'mine now' where id = '10000000-0000-0000-0000-000000000001';
delete from public.climbs where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.check_('someone else cannot read another profile', count(*) = 1) from public.profiles;
do $$ begin insert into public.climbs (user_id, title, video_path, route_color, status, coach_score, analysis) values ('00000000-0000-0000-0000-00000000000a', 'forged', 'x', 'green', 'sent', 1, '{}'); raise notice 'FAIL  a climb cannot be created in someone else''s name'; exception when others then raise notice 'PASS  a climb cannot be created in someone else''s name'; end $$;
do $$ begin perform * from private.settings; raise notice 'FAIL  private settings are unreadable'; exception when others then raise notice 'PASS  private settings are unreadable'; end $$;

-- Moderation: wrong secret refused, right secret lists and approves.
do $$ begin perform * from public.admin_pending('wrong'); raise notice 'FAIL  the queue refuses a wrong secret'; exception when others then raise notice 'PASS  the queue refuses a wrong secret'; end $$;
select pg_temp.check_('the queue lists the pending climb', count(*) = 1) from public.admin_pending('s3cret');
select public.admin_review('s3cret', '10000000-0000-0000-0000-000000000001', true);
select pg_temp.check_('after approval it is in the feed, with the username', count(*) = 1 and min(username) = 'CrimpyGecko42') from public.feed();
select pg_temp.check_('B still could not edit or delete it', title = 'green slab') from public.climbs where id = '10000000-0000-0000-0000-000000000001';
insert into public.props (user_id, climb_id) values (auth.uid(), '10000000-0000-0000-0000-000000000001');
insert into public.saves (user_id, climb_id) values (auth.uid(), '10000000-0000-0000-0000-000000000001');
select pg_temp.check_('B sees the props count and their own props and save', props = '1' and propped and saved and not mine) from public.feed();
select pg_temp.check_('B finds it in saved_feed()', count(*) = 1) from public.saved_feed();
select pg_temp.check_('get_climb() returns the analysis once approved', public.get_climb('10000000-0000-0000-0000-000000000001') -> 'analysis' = '{"holds":[]}');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select pg_temp.check_('the owner sees her exact props count', props = '1' and mine) from public.my_climbs();
update public.climbs set visibility = 'private' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.check_('the owner can take it private again', visibility = 'private') from public.climbs where id = '10000000-0000-0000-0000-000000000001';
update public.climbs set visibility = 'public' where id = '10000000-0000-0000-0000-000000000001';

-- Storage: own folder only; shared files readable, private ones not.
insert into storage.objects (bucket_id, name) values ('climb-videos', '00000000-0000-0000-0000-00000000000a/v1.mp4');
do $$ begin insert into storage.objects (bucket_id, name) values ('climb-videos', '00000000-0000-0000-0000-00000000000b/x.mp4'); raise notice 'FAIL  uploads outside your own folder are refused'; exception when others then raise notice 'PASS  uploads outside your own folder are refused'; end $$;
insert into public.climbs (id, user_id, title, video_path, route_color, status, coach_score, analysis) values ('10000000-0000-0000-0000-000000000002', auth.uid(), 'private one', '00000000-0000-0000-0000-00000000000a/v2.mp4', 'green', 'unfinished', 55, '{}');
insert into storage.objects (bucket_id, name) values ('climb-videos', '00000000-0000-0000-0000-00000000000a/v2.mp4');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check_('B can read the shared video and not the private one', count(*) = 1 and min(name) like '%v1.mp4') from storage.objects;
reset role; set role anon; set request.jwt.claim.sub = '';
select pg_temp.check_('signed-out visitors see only approved public climbs', count(*) = 1) from public.climbs;
reset role; set role authenticated;

-- Reports: the third one hides the climb and sends it back to the queue.
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b'; select public.report_climb('10000000-0000-0000-0000-000000000001', 'other');
select public.report_climb('10000000-0000-0000-0000-000000000001', 'other');
select pg_temp.check_('the same person reporting twice counts once', count(*) = 1) from public.feed();
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c'; insert into public.profiles (id, username) values (auth.uid(), 'JuggyLynx33'); select public.report_climb('10000000-0000-0000-0000-000000000001', 'inappropriate');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d'; insert into public.profiles (id, username) values (auth.uid(), 'ChalkyFox58'); select public.report_climb('10000000-0000-0000-0000-000000000001', 'not_climbing');
select pg_temp.check_('three reports hide the climb from the feed', count(*) = 0) from public.feed();
select pg_temp.check_('and put it back in the moderation queue', count(*) = 1 and min(reports) = 3) from public.admin_pending('s3cret');
select public.admin_review('s3cret', '10000000-0000-0000-0000-000000000001', false);
select pg_temp.check_('a rejected climb is private again and out of the queue', count(*) = 0) from public.admin_pending('s3cret');

-- The daily limit.
reset role; update private.settings set value = '2' where key = 'uploads_per_day'; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
insert into public.climbs (user_id, video_path, route_color, status, coach_score, analysis) values (auth.uid(), 'c/1', 'red', 'sent', 70, '{}'), (auth.uid(), 'c/2', 'red', 'sent', 70, '{}');
do $$ begin insert into public.climbs (user_id, video_path, route_color, status, coach_score, analysis) values (auth.uid(), 'c/3', 'red', 'sent', 70, '{}'); raise notice 'FAIL  the daily limit stops the next upload'; exception when others then raise notice 'PASS  the daily limit stops the next upload (%)', sqlerrm; end $$;

-- Examples.
select public.admin_mark_example('s3cret', (select id from public.climbs where video_path = 'c/1'));
select pg_temp.check_('a seeded example is public, approved and owned by CLIMBR', is_example and is_approved and username = 'CLIMBR') from public.feed() where is_example;

-- The default for a group of friends: shared climbs go straight into the feed.
reset role;
update private.settings set value = 'true' where key = 'auto_approve';
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
insert into public.climbs (id, user_id, title, video_path, route_color, status, coach_score, analysis, is_approved, visibility)
  values ('10000000-0000-0000-0000-0000000000d1', auth.uid(), 'quick share', '00000000-0000-0000-0000-00000000000d/x.mp4', 'blue', 'sent', 77, '{}', false, 'public');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check_('with auto-approve on, a shared climb is in the feed right away', count(*) = 1) from public.feed() where id = '10000000-0000-0000-0000-0000000000d1';
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
update public.climbs set coach_score = 100 where id = '10000000-0000-0000-0000-0000000000d1';
select pg_temp.check_('auto-approve still keeps the score out of the owner''s hands', coach_score = 77) from public.climbs where id = '10000000-0000-0000-0000-0000000000d1';
reset role;
