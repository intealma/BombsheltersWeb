-- Milestone 6: what a kommun may see, decided by a policy the länsstyrelse
-- controls. Three levels, "coarse" by default:
--
--   coarse   aggregates (share checked, share approved, places in approved
--            shelters) and, per shelter, only "Godkänd" or "Ej godkänd ännu".
--            A deficient shelter looks the same as one not yet checked.
--   status   aggregates plus each shelter's full status (Förelagd, Brister, …),
--            still no answers, comments or photos.
--   details  also the submitted self-checks, their answers, photos and reviews
--            for shelters in the kommun.
--
-- Kommuner get their data through two functions (kommun_overview,
-- kommun_shelters) that return exactly what the level allows. The "details"
-- level works by widening the existing RLS policies, gated on the policy.
-- Only a länsstyrelse admin for the kommun's län can change the level.

create type public.kommun_detail_level as enum ('coarse', 'status', 'details');

create table public.kommun_policies (
  kommun_org_id uuid primary key references public.organisations (id) on delete cascade,
  detail_level  public.kommun_detail_level not null default 'coarse',
  updated_by    uuid,
  updated_at    timestamptz not null default now()
);

create trigger audit after insert or update or delete on public.kommun_policies
  for each row execute function private.audit('kommun_org_id', '', 'kommun_org_id');

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------

-- The caller's detail level for a shelter's kommun, or null if the caller is
-- not a member of that kommun's organisation.
create function private.kommun_level_for_shelter(sid text) returns public.kommun_detail_level
language sql stable security definer set search_path = '' as $$
  select coalesce(p.detail_level, 'coarse'::public.kommun_detail_level)
  from public.shelters s
  join public.organisations o on o.kind = 'kommun' and o.kommun_kod = s.kommun_kod
  left join public.kommun_policies p on p.kommun_org_id = o.id
  where s.id = sid and o.id in (select private.my_org_ids())
  order by 1 desc
  limit 1
$$;

create function private.kommun_sees_details(sid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.kommun_level_for_shelter(sid) = 'details', false)
$$;

create function private.lst_admin_lan_kods() returns setof text
language sql stable security definer set search_path = '' as $$
  select o.lan_kod from public.organisations o
  where o.kind = 'lansstyrelse'
    and o.id in (select private.my_org_ids_with_role(array['lst_admin']::public.member_role[]))
$$;

-- Kommun organisations a länsstyrelse may see: those in its län.
create function private.lst_visible_kommun_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select o.id from public.organisations o
  where o.kind = 'kommun' and left(o.kommun_kod, 2) in (select private.my_lst_lan_kods())
$$;

-- --------------------------------------------------------------------------
-- Status rows for the caller's kommun (definer: computes from all tables,
-- but only ever for shelters in the caller's own kommun).
-- --------------------------------------------------------------------------

create function private.kommun_shelter_rows()
returns table (
  shelter_id text, address text, capacity integer, kommun_kod text, lon double precision, lat double precision,
  full_status text, self_check_id uuid, has_check boolean, level public.kommun_detail_level
)
language sql stable security definer set search_path = '' as $$
  with my_kommun as (
    select o.kommun_kod, max(coalesce(p.detail_level, 'coarse'::public.kommun_detail_level)) as level
    from public.organisations o
    left join public.kommun_policies p on p.kommun_org_id = o.id
    where o.kind = 'kommun' and o.id in (select private.my_org_ids())
    group by o.kommun_kod
  ),
  last_order as (
    select distinct on (o.shelter_id) o.shelter_id, o.id as order_id, o.due_date, o.self_check_id
    from public.orders o
    join public.shelters s on s.id = o.shelter_id
    join my_kommun mk on mk.kommun_kod = s.kommun_kod
    where o.cancelled_at is null
    order by o.shelter_id, o.issued_at desc
  ),
  last_check as (
    select distinct on (c.shelter_id) c.shelter_id, c.id as self_check_id
    from public.self_checks c
    join public.shelters s on s.id = c.shelter_id
    join my_kommun mk on mk.kommun_kod = s.kommun_kod
    order by c.shelter_id, c.submitted_at desc
  ),
  last_review as (
    select distinct on (r.self_check_id) r.self_check_id, r.outcome
    from public.self_check_reviews r
    join last_check lc on lc.self_check_id = r.self_check_id
    order by r.self_check_id, r.reviewed_at desc
  )
  -- Same rules as the shelter_review_status view.
  select
    s.id, s.address, s.capacity, s.kommun_kod, s.lon, s.lat,
    case
      when lo.order_id is not null and lo.self_check_id is null then
        case when lo.due_date < (now() at time zone 'Europe/Stockholm')::date then 'forsenad' else 'forelagd' end
      when lc.self_check_id is not null then coalesce(lr.outcome::text, 'inskickad')
      else 'ej_forelagd'
    end,
    lc.self_check_id,
    lc.self_check_id is not null,
    mk.level
  from public.shelters s
  join my_kommun mk on mk.kommun_kod = s.kommun_kod
  left join last_order lo on lo.shelter_id = s.id
  left join last_check lc on lc.shelter_id = s.id
  left join last_review lr on lr.self_check_id = lc.self_check_id
$$;

-- --------------------------------------------------------------------------
-- Functions for the kommun view (SECURITY INVOKER wrappers in public)
-- --------------------------------------------------------------------------

-- Per shelter: coarse status ("godkand" or "ej_godkand") unless the policy
-- allows more. The self-check id is only given at the "details" level.
create function public.kommun_shelters()
returns table (shelter_id text, address text, capacity integer, lon double precision, lat double precision, status text, self_check_id uuid)
language sql stable security invoker set search_path = '' as $$
  select r.shelter_id, r.address, r.capacity, r.lon, r.lat,
         case when r.level = 'coarse'
              then case when r.full_status = 'godkand' then 'godkand' else 'ej_godkand' end
              else r.full_status end,
         case when r.level = 'details' then r.self_check_id end
  from private.kommun_shelter_rows() r
$$;

-- Per kommun: totals, share checked and approved, places in approved
-- shelters. Counts per status only above the "coarse" level.
create function public.kommun_overview()
returns table (
  kommun_kod text, kommun text, detail_level text, shelters integer, capacity bigint,
  checked integer, approved integer, approved_capacity bigint, status_counts jsonb
)
language sql stable security invoker set search_path = '' as $$
  with r as (select * from private.kommun_shelter_rows()),
  counts as (
    select x.kommun_kod, jsonb_object_agg(x.full_status, x.n) as sc
    from (select kommun_kod, full_status, count(*) as n from r group by kommun_kod, full_status) x
    group by x.kommun_kod
  )
  select r.kommun_kod, k.namn, r.level::text,
         count(*)::integer,
         coalesce(sum(r.capacity), 0)::bigint,
         (count(*) filter (where r.has_check))::integer,
         (count(*) filter (where r.full_status = 'godkand'))::integer,
         coalesce(sum(r.capacity) filter (where r.full_status = 'godkand'), 0)::bigint,
         case when r.level = 'coarse' then null else c.sc end
  from r
  join public.kommuner k on k.kod = r.kommun_kod
  left join counts c on c.kommun_kod = r.kommun_kod
  group by r.kommun_kod, k.namn, r.level, c.sc
$$;

-- --------------------------------------------------------------------------
-- Changing the policy: länsstyrelse admins for the kommun's län only.
-- --------------------------------------------------------------------------

create function private.set_kommun_policy(p_kommun_org_id uuid, p_level text) returns public.kommun_policies
language plpgsql security definer set search_path = '' as $$
declare
  v_kod   text;
  v_level public.kommun_detail_level;
  v_row   public.kommun_policies;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select kommun_kod into v_kod from public.organisations where id = p_kommun_org_id and kind = 'kommun';
  if v_kod is null or left(v_kod, 2) not in (select private.lst_admin_lan_kods()) then
    raise exception 'only a länsstyrelse admin for this län can change what the kommun sees' using errcode = '42501';
  end if;
  begin
    v_level := p_level::public.kommun_detail_level;
  exception when invalid_text_representation then
    raise exception 'invalid level' using errcode = '22023';
  end;
  if v_level is null then
    raise exception 'invalid level' using errcode = '22023';
  end if;

  insert into public.kommun_policies (kommun_org_id, detail_level, updated_by, updated_at)
  values (p_kommun_org_id, v_level, auth.uid(), now())
  on conflict (kommun_org_id) do update
    set detail_level = excluded.detail_level, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_row;
  return v_row;
end $$;

create function public.set_kommun_policy(p_kommun_org_id uuid, p_level text) returns public.kommun_policies
language sql security invoker set search_path = '' as $$
  select * from private.set_kommun_policy(p_kommun_org_id, p_level)
$$;

-- --------------------------------------------------------------------------
-- RLS: who can see policies and kommun organisations
-- --------------------------------------------------------------------------

alter table public.kommun_policies enable row level security;

create policy kommun_policies_select on public.kommun_policies
  for select to authenticated using (
    kommun_org_id in (select private.my_org_ids()) or kommun_org_id in (select private.lst_visible_kommun_org_ids())
  );

-- A länsstyrelse now also sees the kommun organisations in its län (to set
-- their policy). Owners and kommuner are unchanged.
drop policy organisations_select on public.organisations;
create policy organisations_select on public.organisations
  for select to authenticated using (
       id in (select private.my_org_ids())
    or id in (select private.lst_visible_owner_org_ids())
    or id in (select private.lst_visible_kommun_org_ids())
  );

-- --------------------------------------------------------------------------
-- The "details" level: widen self-check, photo and review access, gated on
-- the policy. Maintenance photos stay with the owner and the länsstyrelse.
-- --------------------------------------------------------------------------

drop policy self_checks_select on public.self_checks;
create policy self_checks_select on public.self_checks
  for select to authenticated using (
       owner_org_id in (select private.my_org_ids())
    or private.is_shelter_lst(shelter_id)
    or private.kommun_sees_details(shelter_id)
  );

create or replace function private.can_read_self_check(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.self_checks c
    where c.id = cid
      and (c.owner_org_id in (select private.my_org_ids())
           or private.is_shelter_lst(c.shelter_id)
           or private.kommun_sees_details(c.shelter_id))
  )
$$;

drop policy photos_select on public.photos;
create policy photos_select on public.photos
  for select to authenticated using (
       owner_org_id in (select private.my_org_ids())
    or private.is_shelter_lst(shelter_id)
    or (context = 'self_check' and private.kommun_sees_details(shelter_id))
  );

create or replace function private.can_read_photo(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.photos p
    where p.storage_path = path
      and (p.owner_org_id in (select private.my_org_ids())
           or private.is_shelter_lst(p.shelter_id)
           or (p.context = 'self_check' and private.kommun_sees_details(p.shelter_id)))
  )
$$;

drop policy self_check_reviews_select on public.self_check_reviews;
create policy self_check_reviews_select on public.self_check_reviews
  for select to authenticated using (
       lst_org_id in (select private.my_org_ids())
    or owner_org_id in (select private.my_org_ids())
    or private.kommun_sees_details(shelter_id)
  );

create or replace function private.can_read_review(rid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.self_check_reviews r
    where r.id = rid
      and (r.lst_org_id in (select private.my_org_ids())
           or r.owner_org_id in (select private.my_org_ids())
           or private.kommun_sees_details(r.shelter_id))
  )
$$;

-- --------------------------------------------------------------------------
-- Privileges
-- --------------------------------------------------------------------------

revoke all on public.kommun_policies from anon, authenticated;
grant select on public.kommun_policies to authenticated;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.kommun_shelters()',
    'public.kommun_overview()',
    'public.set_kommun_policy(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end $$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
