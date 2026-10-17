-- Milestone 5: orders (förelägganden), review of submissions, and the status
-- every shelter has on the länsstyrelse dashboard.
--
--   order_notices          one per owner organisation per batch: carries the
--                          unique link the länsstyrelse hands to the owner
--   orders                 one per shelter; answered automatically when the
--                          owner submits a self-check for that shelter
--   self_check_reviews     the inspector's verdict on a submission, and
--   self_check_item_reviews  item by item (append-only; a new review replaces
--                          the old one, nothing is overwritten)
--   shelter_review_status  view: Ej förelagd, Förelagd, Försenad, Inskickad,
--                          Godkänd, Brister or Platsbesök krävs per shelter
--
-- The link is a pointer, not a key: opening it still requires signing in as
-- a member of the owner organisation, and row-level security decides what
-- the page shows. Kommuner see none of this (they get aggregates later).

create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- Tables
-- --------------------------------------------------------------------------

create table public.order_notices (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique check (token ~ '^[A-Za-z0-9_-]{24}$'),
  batch_id     uuid not null,
  lst_org_id   uuid not null references public.organisations (id) on delete cascade,
  lst_name     text not null,  -- snapshot, so owners see who issued it
  owner_org_id uuid not null references public.organisations (id) on delete cascade,
  due_date     date not null,
  created_by   uuid not null,
  created_at   timestamptz not null default now()
);

create index order_notices_owner_idx on public.order_notices (owner_org_id, created_at desc);
create index order_notices_lst_idx on public.order_notices (lst_org_id, created_at desc);

create table public.orders (
  id            uuid primary key default gen_random_uuid(),
  notice_id     uuid not null references public.order_notices (id) on delete cascade,
  shelter_id    text not null references public.shelters (id) on delete cascade,
  lst_org_id    uuid not null references public.organisations (id) on delete cascade,
  owner_org_id  uuid not null references public.organisations (id) on delete cascade,
  due_date      date not null,
  issued_by     uuid not null,
  issued_at     timestamptz not null default now(),
  self_check_id uuid references public.self_checks (id) on delete set null,
  answered_at   timestamptz,
  cancelled_at  timestamptz,
  cancelled_by  uuid
);

-- At most one open order per shelter.
create unique index orders_one_open_per_shelter on public.orders (shelter_id)
  where cancelled_at is null and self_check_id is null;
create index orders_shelter_idx on public.orders (shelter_id, issued_at desc);
create index orders_notice_idx on public.orders (notice_id);
create index orders_owner_idx on public.orders (owner_org_id);

create type public.review_outcome as enum ('godkand', 'brister', 'platsbesok');

create table public.self_check_reviews (
  id            uuid primary key default gen_random_uuid(),
  self_check_id uuid not null references public.self_checks (id) on delete cascade,
  shelter_id    text not null references public.shelters (id) on delete cascade,
  lst_org_id    uuid not null references public.organisations (id) on delete cascade,
  owner_org_id  uuid not null references public.organisations (id) on delete cascade,
  outcome       public.review_outcome not null,
  comment       text not null default '' check (length(comment) <= 4000),
  reviewed_by   uuid not null,
  reviewed_at   timestamptz not null default now()
);

create index self_check_reviews_check_idx on public.self_check_reviews (self_check_id, reviewed_at desc);

create table public.self_check_item_reviews (
  review_id uuid not null references public.self_check_reviews (id) on delete cascade,
  item_id   uuid not null references public.checklist_items (id),
  decision  text not null check (decision in ('godkand', 'brist', 'platsbesok')),
  comment   text not null default '' check (length(comment) <= 2000),
  primary key (review_id, item_id)
);

create trigger self_check_reviews_immutable before update on public.self_check_reviews
  for each row execute function private.reject_update();
create trigger self_check_item_reviews_immutable before update on public.self_check_item_reviews
  for each row execute function private.reject_update();

create trigger audit after insert or update or delete on public.order_notices
  for each row execute function private.audit('id', '', 'owner_org_id');
create trigger audit after insert or update or delete on public.orders
  for each row execute function private.audit('id', 'shelter_id', 'owner_org_id');
create trigger audit after insert or update or delete on public.self_check_reviews
  for each row execute function private.audit('id', 'shelter_id', 'owner_org_id');

-- A submitted self-check answers the open order for that shelter, if any.
create function private.answer_open_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.orders
    set self_check_id = new.id, answered_at = new.submitted_at
    where shelter_id = new.shelter_id and cancelled_at is null and self_check_id is null;
  return null;
end $$;

create trigger self_checks_answer_order after insert on public.self_checks
  for each row execute function private.answer_open_order();

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------

create function private.new_token() returns text
language sql volatile set search_path = '' as $$
  select translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_')
$$;

-- The caller's länsstyrelse organisations where they may issue orders and review.
create function private.my_lst_work_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select o.id from public.organisations o
  where o.kind = 'lansstyrelse'
    and o.id in (select private.my_org_ids_with_role(array['inspector', 'lst_admin']::public.member_role[]))
$$;

create function private.can_read_review(rid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.self_check_reviews r
    where r.id = rid
      and (r.lst_org_id in (select private.my_org_ids()) or r.owner_org_id in (select private.my_org_ids()))
  )
$$;

-- --------------------------------------------------------------------------
-- create_orders: bulk-order self-checks for shelters in the caller's län.
-- Shelters without a registered owner, or with an open order already, are
-- skipped and counted. Returns a summary with one link per owner.
-- --------------------------------------------------------------------------

create function private.create_orders(p_lst_org_id uuid, p_shelter_ids text[], p_due_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_lan       text;
  v_lst_name  text;
  v_today     date := (now() at time zone 'Europe/Stockholm')::date;
  v_batch     uuid := gen_random_uuid();
  v_requested integer;
  v_in_lan    integer;
  v_no_owner  integer;
  v_open      integer;
  v_created   integer;
  v_notices   jsonb;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_lst_org_id is null or p_lst_org_id not in (select private.my_lst_work_org_ids()) then
    raise exception 'only länsstyrelse inspectors can issue orders' using errcode = '42501';
  end if;
  select lan_kod, name into v_lan, v_lst_name from public.organisations where id = p_lst_org_id;

  if p_due_date is null or p_due_date < v_today + 1 or p_due_date > v_today + 365 then
    raise exception 'the due date must be between tomorrow and one year ahead' using errcode = '22023';
  end if;

  select count(distinct x) into v_requested from unnest(coalesce(p_shelter_ids, '{}')) as x;
  if v_requested = 0 or v_requested > 5000 then
    raise exception 'choose between 1 and 5000 shelters' using errcode = '22023';
  end if;

  if (select count(*) from public.orders
      where issued_by = auth.uid() and issued_at > now() - interval '1 hour') + v_requested > 10000 then
    raise exception 'too many orders, try again later' using errcode = 'PT429';
  end if;

  select count(*) into v_in_lan
  from public.shelters s
  where s.id = any (p_shelter_ids) and s.lan_kod = v_lan;

  select count(*) into v_no_owner
  from public.shelters s
  where s.id = any (p_shelter_ids) and s.lan_kod = v_lan
    and not exists (select 1 from public.shelter_assignments a where a.shelter_id = s.id);

  select count(*) into v_open
  from public.shelters s
  join public.shelter_assignments a on a.shelter_id = s.id
  where s.id = any (p_shelter_ids) and s.lan_kod = v_lan
    and exists (select 1 from public.orders o where o.shelter_id = s.id and o.cancelled_at is null and o.self_check_id is null);

  with cand as (
    select s.id as shelter_id, a.owner_org_id
    from public.shelters s
    join public.shelter_assignments a on a.shelter_id = s.id
    where s.id = any (p_shelter_ids) and s.lan_kod = v_lan
      and not exists (select 1 from public.orders o where o.shelter_id = s.id and o.cancelled_at is null and o.self_check_id is null)
  ),
  notices as (
    insert into public.order_notices (token, batch_id, lst_org_id, lst_name, owner_org_id, due_date, created_by)
    select private.new_token(), v_batch, p_lst_org_id, v_lst_name, x.owner_org_id, p_due_date, auth.uid()
    from (select distinct owner_org_id from cand) x
    returning id, owner_org_id
  ),
  ins as (
    insert into public.orders (notice_id, shelter_id, lst_org_id, owner_org_id, due_date, issued_by)
    select n.id, c.shelter_id, p_lst_org_id, c.owner_org_id, p_due_date, auth.uid()
    from cand c join notices n on n.owner_org_id = c.owner_org_id
    returning shelter_id
  )
  select count(*) into v_created from ins;

  select coalesce(jsonb_agg(jsonb_build_object(
           'notice_id', n.id,
           'token', n.token,
           'owner_org_id', n.owner_org_id,
           'owner_name', o.name,
           'shelters', (select count(*) from public.orders x where x.notice_id = n.id)
         ) order by o.name), '[]'::jsonb)
    into v_notices
  from public.order_notices n
  join public.organisations o on o.id = n.owner_org_id
  where n.batch_id = v_batch;

  return jsonb_build_object(
    'batch_id', v_batch,
    'due_date', p_due_date,
    'requested', v_requested,
    'created', v_created,
    'outside_lan', v_requested - v_in_lan,
    'no_owner', v_no_owner,
    'already_open', v_open,
    'notices', v_notices
  );
end $$;

create function private.cancel_order(p_order_id uuid) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.orders;
begin
  select * into v_row from public.orders where id = p_order_id;
  if not found or v_row.lst_org_id not in (select private.my_lst_work_org_ids()) then
    raise exception 'not allowed to cancel this order' using errcode = '42501';
  end if;
  if v_row.cancelled_at is not null or v_row.self_check_id is not null then
    raise exception 'only open orders can be cancelled' using errcode = '22023';
  end if;
  update public.orders set cancelled_at = now(), cancelled_by = auth.uid()
    where id = p_order_id returning * into v_row;
  return v_row;
end $$;

-- --------------------------------------------------------------------------
-- review_self_check: a decision for every item, plus an overall comment.
-- The outcome follows from the items: any "platsbesök" wins, then any
-- "brist", otherwise "godkänd".
-- --------------------------------------------------------------------------

create function private.review_self_check(p_self_check_id uuid, p_items jsonb, p_comment text)
returns public.self_check_reviews
language plpgsql security definer set search_path = '' as $$
declare
  v_check   public.self_checks;
  v_lst     uuid;
  v_review  public.self_check_reviews;
  v_count   integer;
  v_outcome public.review_outcome;
  v_comment text := private.clean_text(p_comment);
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select * into v_check from public.self_checks where id = p_self_check_id;
  if found then
    select o.id into v_lst
    from public.organisations o
    join public.shelters s on s.lan_kod = o.lan_kod
    where s.id = v_check.shelter_id and o.id in (select private.my_lst_work_org_ids())
    limit 1;
  end if;
  if v_lst is null then
    raise exception 'not allowed to review this self-check' using errcode = '42501';
  end if;

  if (select count(*) from public.self_check_reviews
      where reviewed_by = auth.uid() and reviewed_at > now() - interval '1 hour') >= 200 then
    raise exception 'too many reviews, try again later' using errcode = 'PT429';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'items must be a JSON array' using errcode = '22023';
  end if;
  select count(*) into v_count from public.self_check_answers where self_check_id = p_self_check_id;
  if jsonb_array_length(p_items) <> v_count
     or (select count(distinct i ->> 'item_id') from jsonb_array_elements(p_items) i) <> v_count
     or exists (
       select 1 from jsonb_array_elements(p_items) i
       where not exists (
         select 1 from public.self_check_answers a
         where a.self_check_id = p_self_check_id and a.item_id::text = i ->> 'item_id'
       )
     ) then
    raise exception 'give a decision for every item exactly once' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) i
             where coalesce(i ->> 'decision', '') not in ('godkand', 'brist', 'platsbesok')) then
    raise exception 'invalid decision' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) i where length(private.clean_text(i ->> 'comment')) > 2000)
     or length(v_comment) > 4000 then
    raise exception 'comment too long' using errcode = '22023';
  end if;

  v_outcome := case
    when exists (select 1 from jsonb_array_elements(p_items) i where i ->> 'decision' = 'platsbesok') then 'platsbesok'
    when exists (select 1 from jsonb_array_elements(p_items) i where i ->> 'decision' = 'brist') then 'brister'
    else 'godkand'
  end;

  insert into public.self_check_reviews (self_check_id, shelter_id, lst_org_id, owner_org_id, outcome, comment, reviewed_by)
  values (p_self_check_id, v_check.shelter_id, v_lst, v_check.owner_org_id, v_outcome, v_comment, auth.uid())
  returning * into v_review;

  insert into public.self_check_item_reviews (review_id, item_id, decision, comment)
  select v_review.id, (i ->> 'item_id')::uuid, i ->> 'decision', private.clean_text(i ->> 'comment')
  from jsonb_array_elements(p_items) i;

  return v_review;
end $$;

create function public.create_orders(p_lst_org_id uuid, p_shelter_ids text[], p_due_date date) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.create_orders(p_lst_org_id, p_shelter_ids, p_due_date)
$$;

create function public.cancel_order(p_order_id uuid) returns public.orders
language sql security invoker set search_path = '' as $$
  select * from private.cancel_order(p_order_id)
$$;

create function public.review_self_check(p_self_check_id uuid, p_items jsonb, p_comment text default '')
returns public.self_check_reviews
language sql security invoker set search_path = '' as $$
  select * from private.review_self_check(p_self_check_id, p_items, p_comment)
$$;

-- --------------------------------------------------------------------------
-- Status per shelter. SECURITY INVOKER: every underlying table applies its
-- own RLS for the caller. Rows only for owners (their shelters) and the
-- länsstyrelse (its län); kommuner get nothing here.
-- --------------------------------------------------------------------------

create view public.shelter_review_status with (security_invoker = true) as
with last_order as (
  select distinct on (shelter_id) shelter_id, id as order_id, notice_id, due_date, issued_at, self_check_id
  from public.orders
  where cancelled_at is null
  order by shelter_id, issued_at desc
),
last_check as (
  select distinct on (shelter_id) shelter_id, id as self_check_id, submitted_at, brist_count
  from public.self_checks
  order by shelter_id, submitted_at desc
),
last_review as (
  select distinct on (self_check_id) self_check_id, outcome, reviewed_at
  from public.self_check_reviews
  order by self_check_id, reviewed_at desc
)
select
  s.id as shelter_id,
  s.address,
  s.capacity,
  s.kommun_kod,
  k.namn as kommun,
  s.lan_kod,
  s.lon,
  s.lat,
  a.owner_org_id,
  o.name as owner_name,
  lo.order_id,
  lo.notice_id,
  lo.due_date,
  lo.issued_at,
  lc.self_check_id,
  lc.submitted_at,
  lc.brist_count,
  lr.outcome::text as review_outcome,
  lr.reviewed_at,
  case
    when lo.order_id is not null and lo.self_check_id is null then
      case when lo.due_date < (now() at time zone 'Europe/Stockholm')::date then 'forsenad' else 'forelagd' end
    when lc.self_check_id is not null then coalesce(lr.outcome::text, 'inskickad')
    else 'ej_forelagd'
  end as status
from public.shelters s
join public.kommuner k on k.kod = s.kommun_kod
left join public.shelter_assignments a on a.shelter_id = s.id
left join public.organisations o on o.id = a.owner_org_id
left join last_order lo on lo.shelter_id = s.id
left join last_check lc on lc.shelter_id = s.id
left join last_review lr on lr.self_check_id = lc.self_check_id
where s.id in (select private.my_owned_shelter_ids())
   or s.lan_kod in (select private.my_lst_lan_kods());

-- --------------------------------------------------------------------------
-- Row-level security
-- --------------------------------------------------------------------------

alter table public.order_notices           enable row level security;
alter table public.orders                  enable row level security;
alter table public.self_check_reviews      enable row level security;
alter table public.self_check_item_reviews enable row level security;

create policy order_notices_select on public.order_notices
  for select to authenticated using (
    lst_org_id in (select private.my_org_ids()) or owner_org_id in (select private.my_org_ids())
  );

create policy orders_select on public.orders
  for select to authenticated using (
    lst_org_id in (select private.my_org_ids()) or owner_org_id in (select private.my_org_ids())
  );

create policy self_check_reviews_select on public.self_check_reviews
  for select to authenticated using (
    lst_org_id in (select private.my_org_ids()) or owner_org_id in (select private.my_org_ids())
  );

create policy self_check_item_reviews_select on public.self_check_item_reviews
  for select to authenticated using (private.can_read_review(review_id));

revoke all on public.order_notices, public.orders, public.self_check_reviews,
  public.self_check_item_reviews, public.shelter_review_status from anon, authenticated;
grant select on public.order_notices, public.orders, public.self_check_reviews,
  public.self_check_item_reviews, public.shelter_review_status to authenticated;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.create_orders(uuid, text[], date)',
    'public.cancel_order(uuid)',
    'public.review_self_check(uuid, jsonb, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end $$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
