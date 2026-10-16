-- Milestone 2: the simplified self-inspection (förenklad kontroll).
--
--   checklist_templates / checklist_items   the checklist, as data (not code)
--   self_checks / self_check_answers        submitted inspections, immutable
--   photos                                  photo records; files live in the
--                                           private `photos` storage bucket
--
-- Users never write these tables directly. Two functions do all writes and
-- validate everything in one place:
--   register_photo     called by the upload-photo edge function after it has
--                      stripped EXIF metadata, before it stores the file
--   submit_self_check  validates and stores a whole inspection at once
-- Both are SECURITY DEFINER in `private`, exposed through thin SECURITY
-- INVOKER wrappers in `public`, so the "no definer functions in public"
-- invariant from milestone 1 still holds.

-- --------------------------------------------------------------------------
-- Checklist (configurable data)
-- --------------------------------------------------------------------------

create table public.checklist_templates (
  id             uuid primary key default gen_random_uuid(),
  key            text not null check (key ~ '^[a-z0-9-]{1,60}$'),
  version        integer not null check (version >= 1),
  title_sv       text not null,
  title_en       text not null,
  description_sv text not null default '',
  description_en text not null default '',
  -- True until MCF or the länsstyrelse provides the official checklist.
  is_placeholder boolean not null default true,
  active         boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (key, version)
);

create unique index checklist_templates_one_active on public.checklist_templates (key) where active;

create table public.checklist_items (
  id                      uuid primary key default gen_random_uuid(),
  template_id             uuid not null references public.checklist_templates (id) on delete cascade,
  position                integer not null check (position >= 1),
  key                     text not null check (key ~ '^[a-z0-9_-]{1,40}$'),
  title_sv                text not null,
  title_en                text not null,
  help_sv                 text not null default '',
  help_en                 text not null default '',
  photo_required_on_brist boolean not null default true,
  unique (template_id, key),
  unique (template_id, position)
);

-- PLACEHOLDER checklist. Replace with the official one from MCF or the
-- länsstyrelse by inserting a new version and making it active.
with t as (
  insert into public.checklist_templates (key, version, title_sv, title_en, description_sv, description_en, is_placeholder, active)
  values (
    'forenklad-kontroll', 1,
    'Förenklad kontroll (platshållare)',
    'Simplified inspection (placeholder)',
    'Platshållare. Punkterna ersätts när MCF eller länsstyrelsen har fastställt den officiella checklistan.',
    'Placeholder. The items will be replaced once MCF or the county board has issued the official checklist.',
    true, true
  )
  returning id
)
insert into public.checklist_items (template_id, position, key, title_sv, title_en, help_sv, help_en)
select t.id, i.position, i.key, i.title_sv, i.title_en, i.help_sv, i.help_en
from t, (values
  (1, 'skylt',
   'Skyddsrumsskylt på fasaden och längs vägen dit',
   'Shelter sign on the facade and along the route',
   'Skylten ska synas från gatan och vägen till skyddsrummet ska vara skyltad.',
   'The sign should be visible from the street and the route to the shelter signposted.'),
  (2, 'atkomst',
   'Tillträdet är inte blockerat av förråd eller föremål',
   'Access is not blocked by stored items',
   'Gå vägen in. Inget får stå i vägen för dörrar eller trappor.',
   'Walk the way in. Nothing may block doors or stairs.'),
  (3, 'dorr',
   'Skyddsrumsdörren och gångjärnen fungerar',
   'Shelter door and hinges work',
   'Öppna och stäng dörren helt. Den ska gå att regla.',
   'Open and close the door fully. It must be possible to bolt it.'),
  (4, 'golvbrunn',
   'Golvbrunnens avstängning fungerar',
   'Floor drain closure works',
   'Kontrollera att avstängningen finns och går att stänga.',
   'Check that the closure is present and can be shut.'),
  (5, 'ventilation',
   'Ventilationsaggregat och filter finns och är hela',
   'Ventilation unit and filters present and intact',
   'Aggregat, filter och slangar ska finnas på plats och vara oskadade.',
   'Unit, filters and hoses should be in place and undamaged.'),
  (6, 'utrustning',
   'Utrustningsförrådet är komplett (monteras inom 48 timmar)',
   'Equipment store complete (to be mounted within 48 hours)',
   'Jämför med förteckningen över utrustning som ska monteras vid höjd beredskap.',
   'Compare with the list of equipment to be mounted at heightened alert.'),
  (7, 'nodutgang',
   'Nödutgången är fri',
   'Emergency exit clear',
   'Nödutgången ska gå att öppna och vara fri på båda sidor.',
   'The emergency exit must open and be clear on both sides.')
) as i (position, key, title_sv, title_en, help_sv, help_en);

-- --------------------------------------------------------------------------
-- Self-checks and answers (immutable once submitted)
-- --------------------------------------------------------------------------

create type public.check_status as enum ('ok', 'brist', 'ej_tillampligt');

create table public.self_checks (
  -- Generated on the device when the draft starts, so a retried submit
  -- (flaky basement connection) can never create a duplicate.
  id             uuid primary key,
  shelter_id     text not null references public.shelters (id) on delete cascade,
  owner_org_id   uuid not null references public.organisations (id) on delete cascade,
  template_id    uuid not null references public.checklist_templates (id),
  inspector_name text not null check (length(inspector_name) between 2 and 120),
  submitted_by   uuid not null,
  started_at     timestamptz,
  submitted_at   timestamptz not null default now(),
  ok_count       integer not null check (ok_count >= 0),
  brist_count    integer not null check (brist_count >= 0),
  na_count       integer not null check (na_count >= 0)
);

create index self_checks_shelter_idx on public.self_checks (shelter_id, submitted_at desc);
create index self_checks_org_idx on public.self_checks (owner_org_id, submitted_at desc);
create index self_checks_submitter_idx on public.self_checks (submitted_by, submitted_at desc);

create table public.self_check_answers (
  self_check_id uuid not null references public.self_checks (id) on delete cascade,
  item_id       uuid not null references public.checklist_items (id),
  -- Snapshot of the item as it read when the check was done.
  position      integer not null,
  item_key      text not null,
  item_title_sv text not null,
  item_title_en text not null,
  status        public.check_status not null,
  comment       text not null default '' check (length(comment) <= 2000),
  primary key (self_check_id, item_id)
);

-- --------------------------------------------------------------------------
-- Photos (records here, files in the private `photos` bucket)
-- --------------------------------------------------------------------------

create table public.photos (
  id           uuid primary key,  -- generated on the device
  shelter_id   text not null references public.shelters (id) on delete cascade,
  owner_org_id uuid not null references public.organisations (id) on delete cascade,
  context      text not null check (context in ('self_check', 'maintenance')),
  context_id   uuid not null,
  item_key     text check (item_key ~ '^[a-z0-9_-]{1,40}$'),
  storage_path text not null unique,
  bytes        integer not null check (bytes between 1 and 5242880),
  width        integer not null check (width between 1 and 8000),
  height       integer not null check (height between 1 and 8000),
  uploaded_by  uuid not null,
  created_at   timestamptz not null default now()
);

create index photos_context_idx on public.photos (context, context_id);
create index photos_uploader_idx on public.photos (uploaded_by, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- --------------------------------------------------------------------------
-- Immutability and audit
-- --------------------------------------------------------------------------

create function private.reject_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% rows cannot be changed once submitted', tg_table_name using errcode = 'insufficient_privilege';
end $$;

create trigger self_checks_immutable before update on public.self_checks
  for each row execute function private.reject_update();
create trigger self_check_answers_immutable before update on public.self_check_answers
  for each row execute function private.reject_update();
create trigger photos_immutable before update on public.photos
  for each row execute function private.reject_update();

create trigger audit after insert or update or delete on public.self_checks
  for each row execute function private.audit('id', 'shelter_id', 'owner_org_id');
create trigger audit after insert or update or delete on public.photos
  for each row execute function private.audit('id', 'shelter_id', 'owner_org_id');

-- --------------------------------------------------------------------------
-- Access helpers
-- --------------------------------------------------------------------------

-- The owner organisation of a shelter, if the caller may act for it
-- (owner admin or caretaker). Null otherwise.
create function private.my_owner_org_for_shelter(sid text) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.owner_org_id
  from public.shelter_assignments a
  where a.shelter_id = sid
    and a.owner_org_id in (
      select private.my_org_ids_with_role(array['owner_admin', 'caretaker']::public.member_role[])
    )
$$;

create function private.can_read_self_check(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.self_checks c
    where c.id = cid
      and (c.owner_org_id in (select private.my_org_ids()) or private.is_shelter_lst(c.shelter_id))
  )
$$;

create function private.can_read_photo(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.photos p
    where p.storage_path = path
      and (p.owner_org_id in (select private.my_org_ids()) or private.is_shelter_lst(p.shelter_id))
  )
$$;

-- Strips control characters except tab and newline.
create function private.clean_text(value text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(coalesce(value, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g'))
$$;

-- --------------------------------------------------------------------------
-- register_photo: records a photo the edge function is about to store and
-- returns the storage path. Fails unless the caller may act for the shelter.
-- --------------------------------------------------------------------------

create function private.register_photo(
  p_id uuid, p_shelter_id text, p_context text, p_context_id uuid, p_item_key text,
  p_bytes integer, p_width integer, p_height integer
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_existing public.photos;
  v_path     text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  v_org := private.my_owner_org_for_shelter(p_shelter_id);
  if v_org is null then
    raise exception 'not allowed to add photos for this shelter' using errcode = '42501';
  end if;

  if p_context is null or p_context not in ('self_check', 'maintenance') then
    raise exception 'invalid photo context' using errcode = '22023';
  end if;

  select * into v_existing from public.photos where id = p_id;
  if found then
    -- A retried upload of the same photo: hand back the same path.
    if v_existing.uploaded_by = auth.uid() and v_existing.shelter_id = p_shelter_id
       and v_existing.context_id = p_context_id then
      return v_existing.storage_path;
    end if;
    raise exception 'photo id already in use' using errcode = '23505';
  end if;

  if p_context = 'self_check' and exists (select 1 from public.self_checks where id = p_context_id) then
    raise exception 'this self-check has already been submitted' using errcode = '22023';
  end if;

  if (select count(*) from public.photos
      where uploaded_by = auth.uid() and created_at > now() - interval '1 hour') >= 100 then
    raise exception 'too many photos, try again later' using errcode = 'PT429';
  end if;

  if (select count(*) from public.photos where context_id = p_context_id) >= 40 then
    raise exception 'too many photos for one inspection' using errcode = '22023';
  end if;

  v_path := format('%s/%s/%s/%s.jpg', p_shelter_id, p_context, p_context_id, p_id);

  insert into public.photos
    (id, shelter_id, owner_org_id, context, context_id, item_key, storage_path, bytes, width, height, uploaded_by)
  values
    (p_id, p_shelter_id, v_org, p_context, p_context_id, nullif(p_item_key, ''), v_path, p_bytes, p_width, p_height, auth.uid());

  return v_path;
end $$;

-- --------------------------------------------------------------------------
-- submit_self_check: validates and stores a whole inspection in one go.
-- p_answers is a JSON array of {item_id, status, comment}, one per item.
-- --------------------------------------------------------------------------

create function private.submit_self_check(
  p_id uuid, p_shelter_id text, p_template_id uuid, p_inspector_name text,
  p_started_at timestamptz, p_answers jsonb
) returns public.self_checks
language plpgsql security definer set search_path = '' as $$
declare
  v_row     public.self_checks;
  v_org     uuid;
  v_name    text := private.clean_text(p_inspector_name);
  v_item    record;
  v_status  public.check_status;
  v_comment text;
  v_items   integer;
  v_ok      integer := 0;
  v_brist   integer := 0;
  v_na      integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  -- Idempotent retry: the same person resubmitting the same draft gets the
  -- stored result back instead of an error or a duplicate.
  select * into v_row from public.self_checks where id = p_id;
  if found then
    if v_row.submitted_by = auth.uid() and v_row.shelter_id = p_shelter_id then
      return v_row;
    end if;
    raise exception 'self-check id already in use' using errcode = '23505';
  end if;

  v_org := private.my_owner_org_for_shelter(p_shelter_id);
  if v_org is null then
    raise exception 'not allowed to submit for this shelter' using errcode = '42501';
  end if;

  if (select count(*) from public.self_checks
      where submitted_by = auth.uid() and submitted_at > now() - interval '1 hour') >= 20 then
    raise exception 'too many submissions, try again later' using errcode = 'PT429';
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'inspector name must be 2 to 120 characters' using errcode = '22023';
  end if;

  if not exists (select 1 from public.checklist_templates where id = p_template_id) then
    raise exception 'unknown checklist' using errcode = '22023';
  end if;

  if jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception 'answers must be a JSON array' using errcode = '22023';
  end if;

  select count(*) into v_items from public.checklist_items where template_id = p_template_id;
  if jsonb_array_length(p_answers) <> v_items
     or (select count(distinct a ->> 'item_id') from jsonb_array_elements(p_answers) a) <> v_items
     or exists (
       select 1 from jsonb_array_elements(p_answers) a
       where not exists (
         select 1 from public.checklist_items i
         where i.template_id = p_template_id and i.id::text = a ->> 'item_id'
       )
     ) then
    raise exception 'answers must cover every checklist item exactly once' using errcode = '22023';
  end if;

  for v_item in
    select i.key, i.photo_required_on_brist, a.value as answer
    from public.checklist_items i
    join jsonb_array_elements(p_answers) a on a.value ->> 'item_id' = i.id::text
    where i.template_id = p_template_id
    order by i.position
  loop
    begin
      v_status := (v_item.answer ->> 'status')::public.check_status;
    exception when invalid_text_representation then
      raise exception 'invalid status for item %', v_item.key using errcode = '22023';
    end;
    if v_status is null then
      raise exception 'missing status for item %', v_item.key using errcode = '22023';
    end if;

    v_comment := private.clean_text(v_item.answer ->> 'comment');
    if length(v_comment) > 2000 then
      raise exception 'comment for item % is too long', v_item.key using errcode = '22023';
    end if;

    -- A deficiency needs at least one photo that was actually stored.
    if v_status = 'brist' and v_item.photo_required_on_brist and not exists (
      select 1
      from public.photos p
      join storage.objects o on o.bucket_id = 'photos' and o.name = p.storage_path
      where p.context = 'self_check' and p.context_id = p_id
        and p.item_key = v_item.key and p.shelter_id = p_shelter_id
    ) then
      raise exception 'a photo is required for the deficiency in item %', v_item.key using errcode = '22023';
    end if;

    case v_status
      when 'ok' then v_ok := v_ok + 1;
      when 'brist' then v_brist := v_brist + 1;
      else v_na := v_na + 1;
    end case;
  end loop;

  insert into public.self_checks
    (id, shelter_id, owner_org_id, template_id, inspector_name, submitted_by, started_at,
     ok_count, brist_count, na_count)
  values
    (p_id, p_shelter_id, v_org, p_template_id, v_name, auth.uid(),
     case when p_started_at between now() - interval '30 days' and now() then p_started_at end,
     v_ok, v_brist, v_na)
  returning * into v_row;

  insert into public.self_check_answers
    (self_check_id, item_id, position, item_key, item_title_sv, item_title_en, status, comment)
  select p_id, i.id, i.position, i.key, i.title_sv, i.title_en,
         (a.value ->> 'status')::public.check_status,
         private.clean_text(a.value ->> 'comment')
  from public.checklist_items i
  join jsonb_array_elements(p_answers) a on a.value ->> 'item_id' = i.id::text
  where i.template_id = p_template_id;

  return v_row;
end $$;

-- Thin wrappers so the Data API can call the functions above.
create function public.register_photo(
  p_id uuid, p_shelter_id text, p_context text, p_context_id uuid, p_item_key text,
  p_bytes integer, p_width integer, p_height integer
) returns text
language sql security invoker set search_path = '' as $$
  select private.register_photo(p_id, p_shelter_id, p_context, p_context_id, p_item_key, p_bytes, p_width, p_height)
$$;

create function public.submit_self_check(
  p_id uuid, p_shelter_id text, p_template_id uuid, p_inspector_name text,
  p_started_at timestamptz, p_answers jsonb
) returns public.self_checks
language sql security invoker set search_path = '' as $$
  select * from private.submit_self_check(p_id, p_shelter_id, p_template_id, p_inspector_name, p_started_at, p_answers)
$$;

-- --------------------------------------------------------------------------
-- Row-level security
-- --------------------------------------------------------------------------

alter table public.checklist_templates enable row level security;
alter table public.checklist_items     enable row level security;
alter table public.self_checks         enable row level security;
alter table public.self_check_answers  enable row level security;
alter table public.photos              enable row level security;

create policy checklist_templates_select on public.checklist_templates
  for select to authenticated using (true);
create policy checklist_items_select on public.checklist_items
  for select to authenticated using (true);

-- The organisation that submitted a check sees it, and so does the
-- länsstyrelse for the shelter's län. Kommuner see aggregates only (later).
create policy self_checks_select on public.self_checks
  for select to authenticated using (
    owner_org_id in (select private.my_org_ids()) or private.is_shelter_lst(shelter_id)
  );

create policy self_check_answers_select on public.self_check_answers
  for select to authenticated using (private.can_read_self_check(self_check_id));

create policy photos_select on public.photos
  for select to authenticated using (
    owner_org_id in (select private.my_org_ids()) or private.is_shelter_lst(shelter_id)
  );

-- Storage: reading a photo file (which is what creating a signed URL
-- requires) follows the photo record. There are no insert, update or delete
-- policies, so only the edge function (service role) can store files.
create policy photos_bucket_select on storage.objects
  for select to authenticated using (bucket_id = 'photos' and private.can_read_photo(name));

-- --------------------------------------------------------------------------
-- Privileges
-- --------------------------------------------------------------------------

revoke all on public.checklist_templates, public.checklist_items, public.self_checks,
  public.self_check_answers, public.photos from anon, authenticated;
grant select on public.checklist_templates, public.checklist_items, public.self_checks,
  public.self_check_answers, public.photos to authenticated;

revoke all on function public.register_photo(uuid, text, text, uuid, text, integer, integer, integer) from public, anon;
revoke all on function public.submit_self_check(uuid, text, uuid, text, timestamptz, jsonb) from public, anon;
grant execute on function public.register_photo(uuid, text, text, uuid, text, integer, integer, integer) to authenticated, service_role;
grant execute on function public.submit_self_check(uuid, text, uuid, text, timestamptz, jsonb) to authenticated, service_role;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
