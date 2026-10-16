-- Milestone 3: the maintenance log (underhållslogg).
--
-- The state does not compensate owners for damage caused by neglected
-- maintenance, so this log is evidence. It is therefore append-only:
--   * entries cannot be edited or deleted by anyone through the API, and an
--     update is rejected even for the service role;
--   * a mistaken entry is voided (makulerad) with a reason, by an owner
--     admin, and stays visible and exported as voided;
--   * the date the work was done (performed_on) is the owner's statement;
--     the time it was registered (created_at) is set by the server, and both
--     are shown and exported, so backdating is visible.
--
-- Photos reuse the `photos` table and bucket from milestone 2 with
-- context = 'maintenance'.

create table public.maintenance_entries (
  id           uuid primary key,  -- generated on the device, so a retried save is idempotent
  shelter_id   text not null references public.shelters (id) on delete cascade,
  owner_org_id uuid not null references public.organisations (id) on delete cascade,
  performed_on date not null,
  category     text not null check (category in (
                 'inspektion', 'reparation', 'ventilation', 'dorrar',
                 'utrustning', 'rensning', 'skyltning', 'ovrigt')),
  description  text not null check (length(description) between 3 and 4000),
  performed_by text not null check (length(performed_by) between 2 and 200),
  registered_by uuid not null,
  created_at   timestamptz not null default now()
);

create index maintenance_entries_shelter_idx on public.maintenance_entries (shelter_id, performed_on desc);
create index maintenance_entries_org_idx on public.maintenance_entries (owner_org_id, performed_on desc);
create index maintenance_entries_registrar_idx on public.maintenance_entries (registered_by, created_at desc);

create table public.maintenance_voids (
  entry_id     uuid primary key references public.maintenance_entries (id) on delete cascade,
  shelter_id   text not null references public.shelters (id) on delete cascade,
  owner_org_id uuid not null references public.organisations (id) on delete cascade,
  reason       text not null check (length(reason) between 3 and 500),
  voided_by    uuid not null,
  voided_at    timestamptz not null default now()
);

create trigger maintenance_entries_immutable before update on public.maintenance_entries
  for each row execute function private.reject_update();
create trigger maintenance_voids_immutable before update on public.maintenance_voids
  for each row execute function private.reject_update();

create trigger audit after insert or update or delete on public.maintenance_entries
  for each row execute function private.audit('id', 'shelter_id', 'owner_org_id');
create trigger audit after insert or update or delete on public.maintenance_voids
  for each row execute function private.audit('entry_id', 'shelter_id', 'owner_org_id');

-- --------------------------------------------------------------------------
-- register_photo: same as milestone 2, plus no photos once a maintenance
-- entry has been saved.
-- --------------------------------------------------------------------------

create or replace function private.register_photo(
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
    if v_existing.uploaded_by = auth.uid() and v_existing.shelter_id = p_shelter_id
       and v_existing.context_id = p_context_id then
      return v_existing.storage_path;
    end if;
    raise exception 'photo id already in use' using errcode = '23505';
  end if;

  if p_context = 'self_check' and exists (select 1 from public.self_checks where id = p_context_id) then
    raise exception 'this self-check has already been submitted' using errcode = '22023';
  end if;
  if p_context = 'maintenance' and exists (select 1 from public.maintenance_entries where id = p_context_id) then
    raise exception 'this maintenance entry has already been saved' using errcode = '22023';
  end if;

  if (select count(*) from public.photos
      where uploaded_by = auth.uid() and created_at > now() - interval '1 hour') >= 100 then
    raise exception 'too many photos, try again later' using errcode = 'PT429';
  end if;

  if (select count(*) from public.photos where context_id = p_context_id) >= 40 then
    raise exception 'too many photos for one inspection or entry' using errcode = '22023';
  end if;

  v_path := format('%s/%s/%s/%s.jpg', p_shelter_id, p_context, p_context_id, p_id);

  insert into public.photos
    (id, shelter_id, owner_org_id, context, context_id, item_key, storage_path, bytes, width, height, uploaded_by)
  values
    (p_id, p_shelter_id, v_org, p_context, p_context_id, nullif(p_item_key, ''), v_path, p_bytes, p_width, p_height, auth.uid());

  return v_path;
end $$;

-- --------------------------------------------------------------------------
-- add_maintenance_entry
-- --------------------------------------------------------------------------

create function private.add_maintenance_entry(
  p_id uuid, p_shelter_id text, p_performed_on date, p_category text,
  p_description text, p_performed_by text
) returns public.maintenance_entries
language plpgsql security definer set search_path = '' as $$
declare
  v_row         public.maintenance_entries;
  v_org         uuid;
  v_today       date := (now() at time zone 'Europe/Stockholm')::date;
  v_description text := private.clean_text(p_description);
  v_by          text := private.clean_text(p_performed_by);
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select * into v_row from public.maintenance_entries where id = p_id;
  if found then
    if v_row.registered_by = auth.uid() and v_row.shelter_id = p_shelter_id then
      return v_row;
    end if;
    raise exception 'entry id already in use' using errcode = '23505';
  end if;

  v_org := private.my_owner_org_for_shelter(p_shelter_id);
  if v_org is null then
    raise exception 'not allowed to log maintenance for this shelter' using errcode = '42501';
  end if;

  if (select count(*) from public.maintenance_entries
      where registered_by = auth.uid() and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'too many entries, try again later' using errcode = 'PT429';
  end if;

  if p_performed_on is null or p_performed_on > v_today or p_performed_on < v_today - interval '2 years' then
    raise exception 'the date must be today or within the last two years' using errcode = '22023';
  end if;

  if p_category is null or p_category not in
     ('inspektion', 'reparation', 'ventilation', 'dorrar', 'utrustning', 'rensning', 'skyltning', 'ovrigt') then
    raise exception 'invalid category' using errcode = '22023';
  end if;

  if length(v_description) < 3 or length(v_description) > 4000 then
    raise exception 'describe what was done (3 to 4000 characters)' using errcode = '22023';
  end if;

  if length(v_by) < 2 or length(v_by) > 200 then
    raise exception 'say who did the work (2 to 200 characters)' using errcode = '22023';
  end if;

  insert into public.maintenance_entries
    (id, shelter_id, owner_org_id, performed_on, category, description, performed_by, registered_by)
  values
    (p_id, p_shelter_id, v_org, p_performed_on, p_category, v_description, v_by, auth.uid())
  returning * into v_row;

  return v_row;
end $$;

-- --------------------------------------------------------------------------
-- void_maintenance_entry: only an owner admin of the entry's organisation.
-- --------------------------------------------------------------------------

create function private.void_maintenance_entry(p_entry_id uuid, p_reason text) returns public.maintenance_voids
language plpgsql security definer set search_path = '' as $$
declare
  v_entry  public.maintenance_entries;
  v_void   public.maintenance_voids;
  v_reason text := private.clean_text(p_reason);
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select * into v_entry from public.maintenance_entries where id = p_entry_id;
  -- Same answer whether the entry is missing or belongs to someone else.
  if not found or v_entry.owner_org_id not in (
    select private.my_org_ids_with_role(array['owner_admin']::public.member_role[])
  ) then
    raise exception 'not allowed to void this entry' using errcode = '42501';
  end if;

  if exists (select 1 from public.maintenance_voids where entry_id = p_entry_id) then
    raise exception 'this entry is already voided' using errcode = '22023';
  end if;

  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'give a reason (3 to 500 characters)' using errcode = '22023';
  end if;

  insert into public.maintenance_voids (entry_id, shelter_id, owner_org_id, reason, voided_by)
  values (p_entry_id, v_entry.shelter_id, v_entry.owner_org_id, v_reason, auth.uid())
  returning * into v_void;

  return v_void;
end $$;

create function public.add_maintenance_entry(
  p_id uuid, p_shelter_id text, p_performed_on date, p_category text,
  p_description text, p_performed_by text
) returns public.maintenance_entries
language sql security invoker set search_path = '' as $$
  select * from private.add_maintenance_entry(p_id, p_shelter_id, p_performed_on, p_category, p_description, p_performed_by)
$$;

create function public.void_maintenance_entry(p_entry_id uuid, p_reason text) returns public.maintenance_voids
language sql security invoker set search_path = '' as $$
  select * from private.void_maintenance_entry(p_entry_id, p_reason)
$$;

-- --------------------------------------------------------------------------
-- Row-level security: the owner organisation and the länsstyrelse for the
-- shelter's län. Kommuner do not see maintenance logs.
-- --------------------------------------------------------------------------

alter table public.maintenance_entries enable row level security;
alter table public.maintenance_voids   enable row level security;

create policy maintenance_entries_select on public.maintenance_entries
  for select to authenticated using (
    owner_org_id in (select private.my_org_ids()) or private.is_shelter_lst(shelter_id)
  );

create policy maintenance_voids_select on public.maintenance_voids
  for select to authenticated using (
    owner_org_id in (select private.my_org_ids()) or private.is_shelter_lst(shelter_id)
  );

revoke all on public.maintenance_entries, public.maintenance_voids from anon, authenticated;
grant select on public.maintenance_entries, public.maintenance_voids to authenticated;

revoke all on function public.add_maintenance_entry(uuid, text, date, text, text, text) from public, anon;
revoke all on function public.void_maintenance_entry(uuid, text) from public, anon;
grant execute on function public.add_maintenance_entry(uuid, text, date, text, text, text) to authenticated, service_role;
grant execute on function public.void_maintenance_entry(uuid, text) to authenticated, service_role;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
