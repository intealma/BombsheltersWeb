-- Run in the Supabase SQL editor (Project -> SQL Editor -> New query).
-- Safe to re-run: every statement is idempotent, including on a database
-- that already has an older shape of these tables from a previous version
-- of this file. Re-running never changes the operator's occupancy switch.
-- Also turn on Authentication -> Providers -> Anonymous Sign-Ins, so the
-- client can get a stable, server-issued identity without collecting a
-- phone number yet.
--
-- Occupancy is never published in real time. See "Public occupancy" further
-- down: only a coarse level ("filling up" / "full") per shelter, 30–45
-- minutes old, and only while the operator has switched it on.

create extension if not exists pgcrypto;

-- Drop the public views up front. The old ones (shelter_status,
-- shelter_activity) published live per-shelter counts of roles, supplies and
-- every check-in timestamp and are gone for good; dropping them also makes
-- old clients fail loudly ("unavailable") instead of showing zeros. The
-- current ones are recreated at the bottom of this file.
drop view if exists shelter_status;
drop view if exists shelter_activity;
drop view if exists shelter_load;
drop view if exists occupancy_publication;

-- `checkins`: who/when only. Each identity can read and close only its own
-- row; nobody else can read it, and it is not in the Realtime publication.
create table if not exists checkins (
  id uuid primary key default gen_random_uuid(),
  shelter_id text not null,              -- matches the "id" property in shelters.geojson, e.g. "100001-7"
  user_id uuid not null references auth.users(id) on delete cascade,
  checked_in_at timestamptz not null default now(),
  checked_out_at timestamptz
);

alter table checkins drop column if exists is_doctor;
alter table checkins drop column if exists is_pregnant;
alter table checkins drop column if exists food_supply;

-- A person can only be actively checked in to ONE shelter at a time. This is
-- what actually stops one person from inflating several shelters' counts —
-- Postgres enforces it at the database level, it does not rely on the
-- client behaving honestly.
create unique index if not exists one_active_checkin_per_user
  on checkins (user_id)
  where checked_out_at is null;

create index if not exists checkins_shelter_active
  on checkins (shelter_id)
  where checked_out_at is null;

-- For the delayed snapshot below: finds check-ins still open at a past instant.
create index if not exists checkins_open_until
  on checkins ((coalesce(checked_out_at, 'infinity'::timestamptz)));

-- Visitors who haven't checked in (`anon`) get nothing. Anonymous sign-ins
-- get the `authenticated` role, and RLS limits them to their own row.
revoke all on checkins from anon, authenticated;
grant select, insert, update on checkins to authenticated;

alter table checkins enable row level security;

drop policy if exists "checkins are publicly readable" on checkins;
drop policy if exists "read own checkin" on checkins;
create policy "read own checkin"
  on checkins for select
  using (user_id = auth.uid());

drop policy if exists "insert own checkin" on checkins;
create policy "insert own checkin"
  on checkins for insert
  with check (user_id = auth.uid());

drop policy if exists "update own checkin" on checkins;
create policy "update own checkin"
  on checkins for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Server-side times. Check-in and check-out are stamped with now() whatever
-- the client sends, and a row can't be moved, backdated or reopened. This is
-- what makes the published snapshot honest: everything it counts happened
-- before the snapshot instant, so nobody can change a level that is already
-- published (or probe one by backdating test check-ins).
create or replace function checkins_server_times()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.checked_in_at := now();
    new.checked_out_at := null;
  else
    new.id := old.id;
    new.shelter_id := old.shelter_id;
    new.user_id := old.user_id;
    new.checked_in_at := old.checked_in_at;
    if old.checked_out_at is not null then
      new.checked_out_at := old.checked_out_at;  -- checking out is final
    elsif new.checked_out_at is not null then
      new.checked_out_at := now();
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists checkins_server_times on checkins;
create trigger checkins_server_times
  before insert or update on checkins
  for each row execute function checkins_server_times();

-- Earlier versions of this file put `checkins` in the Realtime publication so
-- every visitor got live occupancy pushed to them. Take it out.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'checkins'
  ) then
    alter publication supabase_realtime drop table checkins;
  end if;
end $$;

-- `checkin_details`: the check-in questionnaire (party size, special needs,
-- how they can help, what they brought). Readable only by the person who
-- wrote it (and the operator); party size feeds the delayed public level.
create table if not exists checkin_details (
  checkin_id uuid primary key references checkins(id) on delete cascade
);

-- Migrate away the old (doctor/pregnant/single food level) shape if present.
alter table checkin_details drop column if exists is_doctor;
alter table checkin_details drop column if exists is_pregnant;
alter table checkin_details drop column if exists food_supply;

alter table checkin_details add column if not exists adults integer not null default 1;
alter table checkin_details add column if not exists children integer not null default 0;
alter table checkin_details add column if not exists special_needs boolean not null default false;
alter table checkin_details add column if not exists roles text[] not null default '{}';
alter table checkin_details add column if not exists water_brought text;
alter table checkin_details add column if not exists food_brought text;
alter table checkin_details add column if not exists equipment text[] not null default '{}';

-- Upper bounds stop one check-in from claiming hundreds of people and
-- flipping a shelter to "full", which would steer others away from it.
-- `not valid`: checked for new rows only, so re-running never fails on old data.
alter table checkin_details drop constraint if exists checkin_details_adults_check;
alter table checkin_details add constraint checkin_details_adults_check
  check (adults between 1 and 20) not valid;

alter table checkin_details drop constraint if exists checkin_details_children_check;
alter table checkin_details add constraint checkin_details_children_check
  check (children between 0 and 30) not valid;

alter table checkin_details drop constraint if exists checkin_details_water_brought_check;
alter table checkin_details add constraint checkin_details_water_brought_check
  check (water_brought is null or water_brought in ('none', '1-3l', '4l_plus'));

alter table checkin_details drop constraint if exists checkin_details_food_brought_check;
alter table checkin_details add constraint checkin_details_food_brought_check
  check (food_brought is null or food_brought in ('none', '1_day', '2_plus_days'));

alter table checkin_details drop constraint if exists checkin_details_roles_check;
alter table checkin_details add constraint checkin_details_roles_check
  check (roles <@ array['medical', 'leadership', 'technical', 'community', 'volunteer']::text[]);

alter table checkin_details drop constraint if exists checkin_details_equipment_check;
alter table checkin_details add constraint checkin_details_equipment_check
  check (equipment <@ array['power_bank', 'first_aid_kit', 'radio', 'flashlight']::text[]);

revoke all on checkin_details from anon, authenticated;
grant select, insert on checkin_details to authenticated;

alter table checkin_details enable row level security;

drop policy if exists "details visible to shelter-mates" on checkin_details;
drop policy if exists "read own details" on checkin_details;
create policy "read own details"
  on checkin_details for select
  using (
    exists (select 1 from checkins c where c.id = checkin_id and c.user_id = auth.uid())
  );

-- You may only attach details to your own, still open check-in, within 10
-- minutes of checking in. Together with the server-side times above, this
-- means party sizes can't be changed after the fact for a published snapshot.
drop policy if exists "insert own details" on checkin_details;
create policy "insert own details"
  on checkin_details for insert
  with check (
    exists (
      select 1 from checkins c
      where c.id = checkin_id
        and c.user_id = auth.uid()
        and c.checked_out_at is null
        and c.checked_in_at > now() - interval '10 minutes'
    )
  );

-- ---------------------------------------------------------------------
-- Public occupancy
--
-- In wartime, live occupancy (and who is in which shelter) is targeting
-- information. So the public only ever gets:
--   * a level per shelter, "filling" (>= 70 % of capacity) or "full"
--     (>= 100 %). Shelters below that, or with fewer than 5 people, are not
--     listed at all, so a single check-in can never be seen;
--   * as of a past instant: the latest 15-minute boundary that is at least
--     30 minutes old (so 30–45 minutes late), never live;
--   * no counts, roles, needs, supplies or timestamps per check-in;
--   * and only while the operator's switch is on. It starts OFF, a missing
--     setting counts as off, and turning it off empties both views at once
--     for the website and the Android app, with no app update.
--
-- Operator, in the SQL editor:
--   turn on (peacetime):
--     update operator_settings set enabled = true,  updated_at = now() where key = 'public_occupancy_enabled';
--   turn off (heightened alert, or any doubt):
--     update operator_settings set enabled = false, updated_at = now() where key = 'public_occupancy_enabled';
-- Before turning it on, import shelter capacities into `shelter_capacity`
-- (see supabase/build_capacity_csv.py); until that table has rows, nothing
-- is published even with the switch on.
-- ---------------------------------------------------------------------

-- Operator-only switches. RLS on with no policies and no grants: only the
-- SQL editor / service role can read or change them.
create table if not exists operator_settings (
  key text primary key,
  enabled boolean not null,
  updated_at timestamptz not null default now()
);

alter table operator_settings enable row level security;
revoke all on operator_settings from anon, authenticated;

-- `do nothing`: re-running this file never flips the operator's choice.
insert into operator_settings (key, enabled)
values ('public_occupancy_enabled', false)
on conflict (key) do nothing;

-- Shelter capacities from MCF's open data, needed to turn headcounts into
-- levels on the server. Public data, but not exposed through the API (the
-- map already has it in shelters.geojson).
create table if not exists shelter_capacity (
  shelter_id text primary key,           -- same id as checkins.shelter_id
  capacity integer not null check (capacity > 0)
);

alter table shelter_capacity enable row level security;
revoke all on shelter_capacity from anon, authenticated;

-- The instant the public level describes, or null while publishing is off.
-- security definer so anonymous callers can see the switch without being
-- able to read the settings table; fixed search_path so it can't be hijacked.
create or replace function occupancy_as_of()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select date_bin('15 minutes', now() - interval '30 minutes', timestamptz '2000-01-01 00:00:00+00')
  where coalesce(
          (select s.enabled from public.operator_settings s where s.key = 'public_occupancy_enabled'),
          false)
    and exists (select 1 from public.shelter_capacity)
$$;

-- Shelters at or above 70 % of capacity at the snapshot instant. Runs as the
-- owner so it can aggregate everyone's check-ins, but returns nothing more
-- than the level.
create or replace function shelter_load_snapshot()
returns table (shelter_id text, level text)
language sql
stable
security definer
set search_path = ''
as $$
  with snap as (
    select public.occupancy_as_of() as as_of
  ),
  people as (
    select c.shelter_id, sum(coalesce(d.adults, 1) + coalesce(d.children, 0)) as n
    from snap
    join public.checkins c
      on c.checked_in_at <= snap.as_of
     and coalesce(c.checked_out_at, 'infinity'::timestamptz) > snap.as_of
    left join public.checkin_details d on d.checkin_id = c.id
    group by c.shelter_id
  )
  select p.shelter_id,
         case when p.n >= cap.capacity then 'full' else 'filling' end
  from people p
  join public.shelter_capacity cap on cap.shelter_id = p.shelter_id
  where p.n >= 5
    and p.n >= 0.7 * cap.capacity
$$;

revoke all on function occupancy_as_of() from public;
revoke all on function shelter_load_snapshot() from public;
grant execute on function occupancy_as_of() to anon, authenticated;
grant execute on function shelter_load_snapshot() to anon, authenticated;

-- The two public endpoints. security_invoker: the views themselves grant
-- nothing; all access goes through the two functions above.

-- One row: is occupancy published right now, and as of when.
create view occupancy_publication with (security_invoker = true) as
select (s.as_of is not null) as enabled, s.as_of
from (select occupancy_as_of() as as_of) s;

-- One row per shelter that is filling up or full. A shelter that is not
-- listed is not filling up (or publishing is off: check the view above).
create view shelter_load with (security_invoker = true) as
select shelter_id, level from shelter_load_snapshot();

grant select on occupancy_publication to anon, authenticated;
grant select on shelter_load to anon, authenticated;

do $$
begin
  if (select enabled from operator_settings where key = 'public_occupancy_enabled')
     and not exists (select 1 from shelter_capacity) then
    raise notice 'public_occupancy_enabled is on, but shelter_capacity is empty: nothing is published until capacities are imported.';
  end if;
end $$;

-- Force PostgREST to pick up the above immediately rather than waiting for
-- its next scheduled schema-cache refresh.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Security model, honestly stated:
--
-- What THIS enforces today: nobody can read anyone else's check-in, edit
-- someone else's row, backdate or reopen a check-in, forge an occupancy
-- number directly, or hold two simultaneous active check-ins under one
-- identity. The public sees at most a 30–45-minute-old "filling" / "full"
-- level, and nothing at all while the operator switch is off. These rules
-- run on the server, not the client, so devtools don't get around them.
--
-- What THIS does NOT yet enforce: that one human = one identity. Anonymous
-- Auth gives every browser session a real, unforgeable auth.uid(), but
-- nothing stops someone from clearing site data / opening a private window
-- to get a fresh one and checking in again as a "new" person (hCaptcha
-- slows this down; the size caps above limit each identity to 50 people).
-- Closing that gap is the phone-verification step: swap
-- auth.signInAnonymously() for auth.signInWithOtp({ phone }) client-side once
-- Twilio (or similar) is wired into the Supabase project — every RLS policy
-- above already keys off auth.uid(), so nothing here needs to change.
--
-- Legal basis for special_needs / roles (special-category / health-adjacent
-- data under GDPR Art. 9): processing is justified under Art. 9(2)(c),
-- protecting vital interests in an emergency, reinforced by the explicit
-- opt-in each person makes themselves when filling out the form. No name is
-- collected anywhere in this schema. These answers are no longer published
-- in any form; only the person and the operator can read them.
-- ---------------------------------------------------------------------
