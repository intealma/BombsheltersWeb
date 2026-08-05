-- Run in the Supabase SQL editor (Project -> SQL Editor -> New query).
-- Safe to re-run: every statement is idempotent, including on a database
-- that already has an older shape of these tables from a previous version
-- of this file.
-- Also turn on Authentication -> Providers -> Anonymous Sign-Ins, so the
-- client can get a stable, server-issued identity without collecting a
-- phone number yet.

create extension if not exists pgcrypto;

-- Drop the old view up front — it references columns (is_doctor etc.) that
-- are about to be dropped from checkin_details below, so those column drops
-- would otherwise fail with a dependency error. Recreated at the bottom of
-- this file with the new shape.
drop view if exists shelter_status;

-- `checkins`: who/when only. Deliberately public + Realtime-enabled so the
-- live occupancy count works for every visitor, including people deciding
-- where to go who haven't checked in anywhere themselves.
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

grant select, insert, update on checkins to anon, authenticated;

alter table checkins enable row level security;

drop policy if exists "checkins are publicly readable" on checkins;
create policy "checkins are publicly readable"
  on checkins for select
  using (true);

drop policy if exists "insert own checkin" on checkins;
create policy "insert own checkin"
  on checkins for insert
  with check (user_id = auth.uid());

drop policy if exists "update own checkin" on checkins;
create policy "update own checkin"
  on checkins for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'checkins'
  ) then
    alter publication supabase_realtime add table checkins;
  end if;
end $$;

-- `checkin_details`: the full check-in questionnaire (party size, special
-- needs, how they can help, what they brought). Split into its own table
-- specifically so RLS can restrict it to shelter-mates only, without
-- touching the public/Realtime behavior of `checkins` above — Realtime only
-- supports whole tables, and RLS is row-level, not column-level, so this
-- couldn't be done inside one table.
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

alter table checkin_details drop constraint if exists checkin_details_adults_check;
alter table checkin_details add constraint checkin_details_adults_check check (adults >= 1);

alter table checkin_details drop constraint if exists checkin_details_children_check;
alter table checkin_details add constraint checkin_details_children_check check (children >= 0);

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

grant select, insert on checkin_details to anon, authenticated;

alter table checkin_details enable row level security;

-- Visible only to people who themselves have an active check-in at the SAME
-- shelter as the row in question — i.e. actual shelter-mates, enforced
-- server-side. Nobody can read this by tampering with the client.
drop policy if exists "details visible to shelter-mates" on checkin_details;
create policy "details visible to shelter-mates"
  on checkin_details for select
  using (
    exists (
      select 1
      from checkins c
      join checkins mine on mine.shelter_id = c.shelter_id
      where c.id = checkin_details.checkin_id
        and mine.user_id = auth.uid()
        and mine.checked_out_at is null
    )
  );

-- You may only ever attach details to your own check-in.
drop policy if exists "insert own details" on checkin_details;
create policy "insert own details"
  on checkin_details for insert
  with check (
    exists (select 1 from checkins c where c.id = checkin_id and c.user_id = auth.uid())
  );

-- Public, low-resolution rollup — this is what lets someone choose *where*
-- to shelter (e.g. "this one already has medical help"), and what the
-- capacity check compares against. Occupancy sums adults+children per
-- check-in (a family checking in together as one row still counts as
-- however many people they actually are), not just the number of check-in
-- rows. This intentionally is NOT security_invoker, so it runs with the
-- view owner's (postgres) privileges and aggregates across ALL active
-- check-ins regardless of the caller's own RLS visibility into
-- checkin_details — do not add `security_invoker = true` here, that would
-- silently break the public rollup for everyone who isn't a shelter-mate.
create or replace view shelter_status as
select
  c.shelter_id,
  count(*)::int as checkin_count,
  coalesce(sum(coalesce(d.adults, 1) + coalesce(d.children, 0)), 0)::int as current_occupancy,
  coalesce(sum(coalesce(d.adults, 1)), 0)::int as adults_count,
  coalesce(sum(coalesce(d.children, 0)), 0)::int as children_count,
  count(*) filter (where d.special_needs)::int as special_needs_count,
  count(*) filter (where 'medical' = any(d.roles))::int as medical_count,
  count(*) filter (where 'leadership' = any(d.roles))::int as leadership_count,
  count(*) filter (where 'technical' = any(d.roles))::int as technical_count,
  count(*) filter (where 'community' = any(d.roles))::int as community_count,
  count(*) filter (where 'volunteer' = any(d.roles))::int as volunteer_count,
  count(*) filter (where d.water_brought = 'none')::int as water_none_count,
  count(*) filter (where d.water_brought = '1-3l')::int as water_1_3l_count,
  count(*) filter (where d.water_brought = '4l_plus')::int as water_4l_plus_count,
  count(*) filter (where d.food_brought = 'none')::int as food_none_count,
  count(*) filter (where d.food_brought = '1_day')::int as food_1day_count,
  count(*) filter (where d.food_brought = '2_plus_days')::int as food_2plus_count,
  count(*) filter (where 'power_bank' = any(d.equipment))::int as power_bank_count,
  count(*) filter (where 'first_aid_kit' = any(d.equipment))::int as first_aid_kit_count,
  count(*) filter (where 'radio' = any(d.equipment))::int as radio_count,
  count(*) filter (where 'flashlight' = any(d.equipment))::int as flashlight_count
from checkins c
left join checkin_details d on d.checkin_id = c.id
where c.checked_out_at is null
group by c.shelter_id;

grant select on shelter_status to anon, authenticated;

-- Public arrivals timeline (headcount + timestamp per check-in event, no
-- roles/needs/supplies — those stay aggregate-only via shelter_status
-- above, or member-gated via checkin_details). Same view-owner-bypasses-RLS
-- reasoning as shelter_status: do not add security_invoker here.
create or replace view shelter_activity as
select
  c.shelter_id,
  c.checked_in_at,
  coalesce(d.adults, 1) + coalesce(d.children, 0) as people_count
from checkins c
left join checkin_details d on d.checkin_id = c.id;

grant select on shelter_activity to anon, authenticated;

-- Force PostgREST to pick up the above immediately rather than waiting for
-- its next scheduled schema-cache refresh.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Security model, honestly stated:
--
-- What THIS enforces today: nobody can edit someone else's check-in row,
-- forge an occupancy number directly, hold two simultaneous active
-- check-ins under one identity, or read another shelter's roster of who
-- has special needs / what roles or supplies people have unless they are
-- themselves actively checked in there — even a technically sophisticated
-- attacker with devtools open, because these rules run on the server, not
-- the client.
--
-- What THIS does NOT yet enforce: that one human = one identity. Anonymous
-- Auth gives every browser session a real, unforgeable auth.uid(), but
-- nothing stops someone from clearing site data / opening a private window
-- to get a fresh one and checking in again as a "new" person. Closing that
-- gap is the phone-verification step: swap auth.signInAnonymously() for
-- auth.signInWithOtp({ phone }) client-side once Twilio (or similar) is
-- wired into the Supabase project — every RLS policy above already keys off
-- auth.uid(), so nothing here needs to change when that happens.
--
-- Legal basis for special_needs / roles (special-category / health-adjacent
-- data under GDPR Art. 9): processing is justified under Art. 9(2)(c),
-- protecting vital interests in an emergency, reinforced by the explicit
-- opt-in each person makes themselves when filling out the form. No name is
-- collected anywhere in this schema.
-- ---------------------------------------------------------------------
