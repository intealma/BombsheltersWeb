-- Beredskap foundation: reference data, organisations, memberships,
-- shelters, shelter assignments, the audit log, and the access helpers that
-- every later table's row-level security builds on.
--
-- Principles (see docs/threat-model.md):
--   * Deny by default. Every table has RLS enabled, nothing is granted to
--     `anon`, and `authenticated` only gets the privileges listed at the end.
--   * Who can see what is decided here, from memberships, never from
--     anything the client sends.
--   * Helper functions live in the `private` schema, which the Data API does
--     not expose: policies can use them, but they cannot be called over HTTP.
--   * Shelters are assigned to owners only by the service role (an admin or
--     the seed script). There is no policy that lets a user claim one.

create extension if not exists postgis with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- --------------------------------------------------------------------------
-- Types
-- --------------------------------------------------------------------------

create type public.org_kind as enum ('owner', 'lansstyrelse', 'kommun');

create type public.member_role as enum (
  'owner_admin',    -- fastighetsägare: runs the owner organisation
  'caretaker',      -- fastighetsskötare: does the hands-on checks
  'inspector',      -- länsstyrelse: handläggare/inspektör
  'lst_admin',      -- länsstyrelse: administrator
  'kommun_viewer'   -- kommun: read-only overview
);

-- --------------------------------------------------------------------------
-- Reference data (public information, readable by any signed-in member)
-- --------------------------------------------------------------------------

create table public.lan (
  kod  text primary key check (kod ~ '^[0-9]{2}$'),
  namn text not null
);

insert into public.lan (kod, namn) values
  ('01', 'Stockholms län'), ('03', 'Uppsala län'), ('04', 'Södermanlands län'),
  ('05', 'Östergötlands län'), ('06', 'Jönköpings län'), ('07', 'Kronobergs län'),
  ('08', 'Kalmar län'), ('09', 'Gotlands län'), ('10', 'Blekinge län'),
  ('12', 'Skåne län'), ('13', 'Hallands län'), ('14', 'Västra Götalands län'),
  ('17', 'Värmlands län'), ('18', 'Örebro län'), ('19', 'Västmanlands län'),
  ('20', 'Dalarnas län'), ('21', 'Gävleborgs län'), ('22', 'Västernorrlands län'),
  ('23', 'Jämtlands län'), ('24', 'Västerbottens län'), ('25', 'Norrbottens län');

create table public.kommuner (
  kod     text primary key check (kod ~ '^[0-9]{4}$'),
  namn    text not null,
  lan_kod text not null references public.lan (kod),
  check (lan_kod = left(kod, 2))
);

-- --------------------------------------------------------------------------
-- Shelters (imported from the public MCF/MSB data, see scripts/)
-- --------------------------------------------------------------------------

create table public.shelters (
  -- MCF shelter number ("name" in the WFS), e.g. '100001-7'. The same key the
  -- public map and its check-ins use, so the two can always be joined.
  id          text primary key check (id ~ '^[0-9A-Za-z-]{1,32}$'),
  inspire_id  text unique,
  address     text not null default '' check (length(address) <= 300),
  capacity    integer not null default 0 check (capacity >= 0),
  kommun_kod  text not null references public.kommuner (kod),
  lan_kod     text not null references public.lan (kod),
  -- Plain lon/lat are validated against Sweden's bounds, so a malformed
  -- geometry (like the double-nested coordinates that once broke MapLibre)
  -- cannot get in. geom is derived from them by the trigger below.
  lon         double precision not null check (lon between 10.0 and 24.5),
  lat         double precision not null check (lat between 55.0 and 69.5),
  geom        extensions.geography(point, 4326) not null,
  imported_at timestamptz not null default now(),
  check (lan_kod = left(kommun_kod, 2))
);

create index shelters_kommun_idx on public.shelters (kommun_kod);
create index shelters_lan_idx on public.shelters (lan_kod);
create index shelters_geom_idx on public.shelters using gist (geom);

create function private.shelters_derive() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.lan_kod := left(new.kommun_kod, 2);
  new.geom := extensions.st_setsrid(extensions.st_makepoint(new.lon, new.lat), 4326)::extensions.geography;
  return new;
end $$;

create trigger shelters_derive
  before insert or update of kommun_kod, lon, lat on public.shelters
  for each row execute function private.shelters_derive();

-- --------------------------------------------------------------------------
-- Organisations, memberships and profiles
-- --------------------------------------------------------------------------

create table public.organisations (
  id         uuid primary key default gen_random_uuid(),
  kind       public.org_kind not null,
  name       text not null check (length(name) between 2 and 200),
  -- Scope: a länsstyrelse covers one län, a kommun covers one kommun. Owners
  -- have no area; their scope is the shelters assigned to them.
  lan_kod    text references public.lan (kod),
  kommun_kod text references public.kommuner (kod),
  is_demo    boolean not null default false,
  created_at timestamptz not null default now(),
  constraint organisations_scope check (
       (kind = 'owner'        and lan_kod is null     and kommun_kod is null)
    or (kind = 'lansstyrelse' and lan_kod is not null and kommun_kod is null)
    or (kind = 'kommun'       and lan_kod is null     and kommun_kod is not null)
  )
);

create table public.memberships (
  user_id    uuid not null references auth.users (id) on delete cascade,
  org_id     uuid not null references public.organisations (id) on delete cascade,
  role       public.member_role not null,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

create index memberships_org_idx on public.memberships (org_id);

create function private.check_membership_role() returns trigger
language plpgsql set search_path = '' as $$
declare
  k public.org_kind;
begin
  select o.kind into k from public.organisations o where o.id = new.org_id;
  if not (
       (k = 'owner'        and new.role in ('owner_admin', 'caretaker'))
    or (k = 'lansstyrelse' and new.role in ('inspector', 'lst_admin'))
    or (k = 'kommun'       and new.role = 'kommun_viewer')
  ) then
    raise exception 'role % is not valid in a % organisation', new.role, k
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger memberships_check_role
  before insert or update on public.memberships
  for each row execute function private.check_membership_role();

-- Personal data (GDPR): only what the product needs. Email stays in
-- auth.users. Deleting the auth user deletes the profile.
create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null default '' check (length(full_name) <= 120),
  phone      text check (phone is null or phone ~ '^\+?[0-9 ()-]{6,20}$'),
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- Shelter assignments: which owner organisation is responsible for a shelter
-- --------------------------------------------------------------------------

create table public.shelter_assignments (
  shelter_id   text primary key references public.shelters (id) on delete cascade,
  owner_org_id uuid not null references public.organisations (id) on delete cascade,
  assigned_at  timestamptz not null default now(),
  assigned_by  uuid default auth.uid()  -- null when made by the service role / seed
);

create index shelter_assignments_org_idx on public.shelter_assignments (owner_org_id);

create function private.check_assignment_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.organisations o where o.id = new.owner_org_id and o.kind = 'owner') then
    raise exception 'shelters can only be assigned to owner organisations'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger shelter_assignments_check_owner
  before insert or update on public.shelter_assignments
  for each row execute function private.check_assignment_owner();

-- --------------------------------------------------------------------------
-- Audit log: append-only record of who changed what, and when
-- --------------------------------------------------------------------------

create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   uuid,            -- auth.uid(); null for the service role, seed or system
  actor_role text not null,   -- 'authenticated', 'service_role' or the database user
  action     text not null check (action in ('insert', 'update', 'delete')),
  table_name text not null,
  row_key    text not null,
  shelter_id text,            -- set when the row concerns one shelter
  org_id     uuid,            -- set when the row belongs to one organisation
  old_data   jsonb,
  new_data   jsonb
);

create index audit_log_shelter_idx on public.audit_log (shelter_id, at desc);
create index audit_log_org_idx on public.audit_log (org_id, at desc);

-- Generic row trigger. Arguments: key column(s) (comma separated), shelter
-- column or '', organisation column or ''. Runs as the function owner so
-- users never need (or get) insert rights on audit_log themselves.
create function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec         jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  shelter_col text := nullif(tg_argv[1], '');
  org_col     text := nullif(tg_argv[2], '');
begin
  insert into public.audit_log
    (actor_id, actor_role, action, table_name, row_key, shelter_id, org_id, old_data, new_data)
  values (
    auth.uid(),
    coalesce(auth.jwt() ->> 'role', session_user::text),
    lower(tg_op),
    tg_table_name,
    (select string_agg(rec ->> k, ':') from unnest(string_to_array(tg_argv[0], ',')) as k),
    case when shelter_col is not null then rec ->> shelter_col end,
    case when org_col is not null then (rec ->> org_col)::uuid end,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;

create function private.audit_log_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'insufficient_privilege';
end $$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function private.audit_log_immutable();

create trigger audit after insert or update or delete on public.organisations
  for each row execute function private.audit('id', '', 'id');
create trigger audit after insert or update or delete on public.memberships
  for each row execute function private.audit('user_id,org_id', '', 'org_id');
create trigger audit after insert or update or delete on public.shelter_assignments
  for each row execute function private.audit('shelter_id', 'shelter_id', 'owner_org_id');
-- Not audited: shelters (bulk reference data imported by the service role
-- only) and profiles (personal data; keeping copies in an append-only log
-- would block GDPR erasure).

-- --------------------------------------------------------------------------
-- Access helpers. SECURITY DEFINER so they can read memberships without
-- tripping over those tables' own RLS (avoids policy recursion); each one
-- only ever answers questions about the calling user.
-- --------------------------------------------------------------------------

-- Organisations the caller belongs to. Anonymous sessions never count, even
-- if anonymous sign-in were ever switched on by mistake.
create function private.my_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id
  from public.memberships m
  where m.user_id = auth.uid()
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
$$;

create function private.my_org_ids_with_role(roles public.member_role[]) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id
  from public.memberships m
  where m.user_id = auth.uid()
    and m.role = any (roles)
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
$$;

create function private.my_lst_lan_kods() returns setof text
language sql stable security definer set search_path = '' as $$
  select o.lan_kod from public.organisations o
  where o.kind = 'lansstyrelse' and o.id in (select private.my_org_ids())
$$;

create function private.my_kommun_kods() returns setof text
language sql stable security definer set search_path = '' as $$
  select o.kommun_kod from public.organisations o
  where o.kind = 'kommun' and o.id in (select private.my_org_ids())
$$;

create function private.my_owned_shelter_ids() returns setof text
language sql stable security definer set search_path = '' as $$
  select a.shelter_id from public.shelter_assignments a
  where a.owner_org_id in (select private.my_org_ids())
$$;

-- Per-shelter checks, for policies on the tables later milestones add
-- (self-checks, maintenance log, readiness plans, orders).
create function private.is_shelter_owner(sid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shelter_assignments a
    where a.shelter_id = sid and a.owner_org_id in (select private.my_org_ids())
  )
$$;

create function private.is_shelter_lst(sid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shelters s
    where s.id = sid and s.lan_kod in (select private.my_lst_lan_kods())
  )
$$;

create function private.is_shelter_kommun(sid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shelters s
    where s.id = sid and s.kommun_kod in (select private.my_kommun_kods())
  )
$$;

-- Owner organisations a länsstyrelse may see: those responsible for at least
-- one shelter in its län.
create function private.lst_visible_owner_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct a.owner_org_id
  from public.shelter_assignments a
  join public.shelters s on s.id = a.shelter_id
  where s.lan_kod in (select private.my_lst_lan_kods())
$$;

-- People who share at least one organisation with the caller.
create function private.colleague_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id from public.memberships m
  where m.org_id in (select private.my_org_ids())
$$;

-- --------------------------------------------------------------------------
-- Row-level security
-- --------------------------------------------------------------------------

alter table public.lan                 enable row level security;
alter table public.kommuner            enable row level security;
alter table public.shelters            enable row level security;
alter table public.organisations       enable row level security;
alter table public.memberships         enable row level security;
alter table public.profiles            enable row level security;
alter table public.shelter_assignments enable row level security;
alter table public.audit_log           enable row level security;

create policy lan_select on public.lan
  for select to authenticated using (true);

create policy kommuner_select on public.kommuner
  for select to authenticated using (true);

-- Owners see their assigned shelters, a länsstyrelse sees its län, a kommun
-- sees its kommun. Nobody else sees any shelter through this API.
create policy shelters_select on public.shelters
  for select to authenticated using (
       id in (select private.my_owned_shelter_ids())
    or lan_kod in (select private.my_lst_lan_kods())
    or kommun_kod in (select private.my_kommun_kods())
  );

create policy organisations_select on public.organisations
  for select to authenticated using (
       id in (select private.my_org_ids())
    or id in (select private.lst_visible_owner_org_ids())
  );

create policy memberships_select on public.memberships
  for select to authenticated using (org_id in (select private.my_org_ids()));

create policy profiles_select on public.profiles
  for select to authenticated using (
    user_id = (select auth.uid()) or user_id in (select private.colleague_ids())
  );

create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (user_id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Kommuner do not see who owns which shelter.
create policy shelter_assignments_select on public.shelter_assignments
  for select to authenticated using (
       shelter_id in (select private.my_owned_shelter_ids())
    or private.is_shelter_lst(shelter_id)
  );

-- Owner admins see their organisation's history, a länsstyrelse sees the
-- history of shelters in its län. Caretakers and kommuner see none.
create policy audit_log_select on public.audit_log
  for select to authenticated using (
       org_id in (select private.my_org_ids_with_role(array['owner_admin', 'lst_admin', 'inspector']::public.member_role[]))
    or (shelter_id is not null and private.is_shelter_lst(shelter_id))
  );

-- --------------------------------------------------------------------------
-- Privileges. Explicit, because config.toml sets auto_expose_new_tables to
-- false and because the hosted project may default differently.
-- --------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema private from public, anon;

grant select on public.lan, public.kommuner, public.shelters, public.organisations,
  public.memberships, public.shelter_assignments, public.audit_log to authenticated;
grant select, insert on public.profiles to authenticated;
grant update (full_name, phone, updated_at) on public.profiles to authenticated;

grant execute on all functions in schema private to authenticated;

-- The service role (seed scripts, admin tasks) bypasses RLS by design.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema private to service_role;

-- Make objects created by later migrations private by default as well, so
-- forgetting a REVOKE can never expose a new table. Each migration still
-- grants what it needs explicitly.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
