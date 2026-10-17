-- Milestone 4: the 48-hour readiness plan and the simulated activation.
--
--   readiness_task_templates    the task list, as data (placeholder tasks)
--   org_contacts                responsible and backup people (personal data)
--   readiness_tasks             each shelter's tasks, created from the template
--   readiness_activations       "Aktivera höjd beredskap": a 48-hour countdown
--                               for one owner organisation. Phase 1 only allows
--                               simulations (is_simulation must be true).
--   readiness_task_completions  which tasks are done in an activation
--
-- Plans are the owner organisation's own business: neither the länsstyrelse
-- nor the kommun can read them in Phase 1. All writes go through functions.
--
-- Progress is followed by polling, not Supabase Realtime: Realtime does not
-- apply row-level security to DELETE events, and polling keeps every read
-- behind the same tested policies. Completions are therefore never deleted,
-- only switched between done and not done.

-- --------------------------------------------------------------------------
-- Audit: optionally keep personal data out of the log (contacts). The fourth
-- trigger argument 'redact' records who changed which row, but not the data.
-- --------------------------------------------------------------------------

create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec         jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  shelter_col text := nullif(tg_argv[1], '');
  org_col     text := nullif(tg_argv[2], '');
  redact      boolean := coalesce(tg_argv[3], '') = 'redact';
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
    case when tg_op in ('UPDATE', 'DELETE') and not redact then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') and not redact then to_jsonb(new) end
  );
  return null;
end $$;

-- --------------------------------------------------------------------------
-- Task template (configurable data)
-- --------------------------------------------------------------------------

create table public.readiness_task_templates (
  id             uuid primary key default gen_random_uuid(),
  key            text not null unique check (key ~ '^[a-z0-9_-]{1,40}$'),
  position       integer not null unique check (position >= 1),
  title_sv       text not null,
  title_en       text not null,
  help_sv        text not null default '',
  help_en        text not null default '',
  -- Hour within the 48-hour window by which the task should be done.
  target_hour    integer not null check (target_hour between 1 and 48),
  is_placeholder boolean not null default true,
  active         boolean not null default true
);

-- PLACEHOLDER tasks, until official guidance replaces them.
insert into public.readiness_task_templates (key, position, title_sv, title_en, help_sv, help_en, target_hour) values
  ('informera', 1,
   'Informera de boende',
   'Inform the residents',
   'Berätta att skyddsrummet ställs i ordning, var det finns och vad de ska ta med.',
   'Tell residents the shelter is being prepared, where it is and what to bring.',
   6),
  ('tomma', 2,
   'Töm skyddsrummet på förråd och lösa föremål',
   'Empty the shelter of storage and loose items',
   'Förrådsfack, cyklar och annat som står i skyddsrummet ska bort.',
   'Storage units, bicycles and anything else kept in the shelter must go.',
   24),
  ('utrustning', 3,
   'Montera utrustningen',
   'Mount the equipment',
   'Ta fram och montera utrustningen från utrustningsförrådet, till exempel britsar och torrtoaletter.',
   'Bring out and mount the equipment from the equipment store, such as bunks and dry toilets.',
   36),
  ('ventilation', 4,
   'Kontrollera och provkör ventilationen',
   'Check and test-run the ventilation',
   'Kontrollera filter och slangar och provkör aggregatet.',
   'Check filters and hoses and test-run the unit.',
   40),
  ('skyltning', 5,
   'Sätt upp skyltning',
   'Put up signage',
   'Skylta vägen från gatan till skyddsrummet.',
   'Signpost the way from the street to the shelter.',
   44);

-- --------------------------------------------------------------------------
-- Contacts (personal data: only name, phone, optional email and a short role)
-- --------------------------------------------------------------------------

create table public.org_contacts (
  id           uuid primary key,
  owner_org_id uuid not null references public.organisations (id) on delete cascade,
  name         text not null check (length(name) between 2 and 120),
  phone        text not null check (phone ~ '^\+?[0-9 ()-]{6,20}$'),
  email        text check (email is null or (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  role_note    text not null default '' check (length(role_note) <= 120),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index org_contacts_org_idx on public.org_contacts (owner_org_id);

-- --------------------------------------------------------------------------
-- Each shelter's tasks
-- --------------------------------------------------------------------------

create table public.readiness_tasks (
  id                     uuid primary key default gen_random_uuid(),
  shelter_id             text not null references public.shelters (id) on delete cascade,
  owner_org_id           uuid not null references public.organisations (id) on delete cascade,
  template_id            uuid not null references public.readiness_task_templates (id),
  position               integer not null,
  title_sv               text not null,
  title_en               text not null,
  target_hour            integer not null check (target_hour between 1 and 48),
  responsible_contact_id uuid references public.org_contacts (id) on delete set null,
  backup_contact_id      uuid references public.org_contacts (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (shelter_id, template_id),
  check (responsible_contact_id is distinct from backup_contact_id or responsible_contact_id is null)
);

create index readiness_tasks_org_idx on public.readiness_tasks (owner_org_id);

-- --------------------------------------------------------------------------
-- Activations (simulations) and completions
-- --------------------------------------------------------------------------

create table public.readiness_activations (
  id            uuid primary key default gen_random_uuid(),
  owner_org_id  uuid not null references public.organisations (id) on delete cascade,
  -- Phase 1 supports simulations only. Remove this check deliberately, with
  -- its own review, before anything real is ever triggered from here.
  is_simulation boolean not null default true check (is_simulation),
  started_at    timestamptz not null default now(),
  started_by    uuid not null,
  deadline_at   timestamptz not null,
  ended_at      timestamptz,
  ended_by      uuid
);

create unique index readiness_one_active_per_org on public.readiness_activations (owner_org_id) where ended_at is null;

create table public.readiness_task_completions (
  activation_id uuid not null references public.readiness_activations (id) on delete cascade,
  task_id       uuid not null references public.readiness_tasks (id) on delete cascade,
  owner_org_id  uuid not null references public.organisations (id) on delete cascade,
  shelter_id    text not null references public.shelters (id) on delete cascade,
  done          boolean not null,
  done_at       timestamptz,
  done_by       uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid not null,
  primary key (activation_id, task_id)
);

create index readiness_completions_poll_idx on public.readiness_task_completions (activation_id, updated_at);

create trigger audit after insert or update or delete on public.org_contacts
  for each row execute function private.audit('id', '', 'owner_org_id', 'redact');
create trigger audit after insert or update or delete on public.readiness_tasks
  for each row execute function private.audit('id', 'shelter_id', 'owner_org_id');
create trigger audit after insert or update or delete on public.readiness_activations
  for each row execute function private.audit('id', '', 'owner_org_id');
create trigger audit after insert or update or delete on public.readiness_task_completions
  for each row execute function private.audit('activation_id,task_id', 'shelter_id', 'owner_org_id');

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------

create function private.is_owner_admin(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select org in (select private.my_org_ids_with_role(array['owner_admin']::public.member_role[]))
$$;

create function private.is_owner_member(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select org in (select private.my_org_ids_with_role(array['owner_admin', 'caretaker']::public.member_role[]))
$$;

-- --------------------------------------------------------------------------
-- Plan setup
-- --------------------------------------------------------------------------

create function private.setup_readiness_plans(p_org_id uuid, p_shelter_id text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not private.is_owner_admin(p_org_id) then
    raise exception 'only an owner admin can set up readiness plans' using errcode = '42501';
  end if;

  insert into public.readiness_tasks (shelter_id, owner_org_id, template_id, position, title_sv, title_en, target_hour)
  select a.shelter_id, a.owner_org_id, t.id, t.position, t.title_sv, t.title_en, t.target_hour
  from public.shelter_assignments a
  cross join public.readiness_task_templates t
  where a.owner_org_id = p_org_id
    and t.active
    and (p_shelter_id is null or a.shelter_id = p_shelter_id)
  on conflict (shelter_id, template_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- --------------------------------------------------------------------------
-- Contacts
-- --------------------------------------------------------------------------

create function private.save_contact(
  p_id uuid, p_org_id uuid, p_name text, p_phone text, p_email text, p_role_note text
) returns public.org_contacts
language plpgsql security definer set search_path = '' as $$
declare
  v_row   public.org_contacts;
  v_name  text := private.clean_text(p_name);
  v_phone text := private.clean_text(p_phone);
  v_email text := nullif(lower(private.clean_text(p_email)), '');
  v_role  text := private.clean_text(p_role_note);
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not private.is_owner_admin(p_org_id) then
    raise exception 'only an owner admin can manage contacts' using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'name must be 2 to 120 characters' using errcode = '22023';
  end if;
  if v_phone !~ '^\+?[0-9 ()-]{6,20}$' then
    raise exception 'invalid phone number' using errcode = '22023';
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if length(v_role) > 120 then
    raise exception 'role must be at most 120 characters' using errcode = '22023';
  end if;

  select * into v_row from public.org_contacts where id = p_id;
  if found then
    if v_row.owner_org_id <> p_org_id then
      raise exception 'contact id already in use' using errcode = '23505';
    end if;
    update public.org_contacts
      set name = v_name, phone = v_phone, email = v_email, role_note = v_role, updated_at = now()
      where id = p_id
      returning * into v_row;
  else
    insert into public.org_contacts (id, owner_org_id, name, phone, email, role_note)
    values (coalesce(p_id, gen_random_uuid()), p_org_id, v_name, v_phone, v_email, v_role)
    returning * into v_row;
  end if;
  return v_row;
end $$;

-- GDPR erasure: the contact is removed and unassigned from every task.
create function private.delete_contact(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select owner_org_id into v_org from public.org_contacts where id = p_id;
  if v_org is null or not private.is_owner_admin(v_org) then
    raise exception 'not allowed to delete this contact' using errcode = '42501';
  end if;
  delete from public.org_contacts where id = p_id;
end $$;

create function private.assign_readiness_task(p_task_id uuid, p_responsible uuid, p_backup uuid) returns public.readiness_tasks
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.readiness_tasks;
begin
  select * into v_task from public.readiness_tasks where id = p_task_id;
  if not found or not private.is_owner_admin(v_task.owner_org_id) then
    raise exception 'not allowed to change this task' using errcode = '42501';
  end if;
  if p_responsible is not null and p_responsible = p_backup then
    raise exception 'responsible and backup must be different people' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(array[p_responsible, p_backup]) as c(id)
    where c.id is not null
      and not exists (select 1 from public.org_contacts o where o.id = c.id and o.owner_org_id = v_task.owner_org_id)
  ) then
    raise exception 'contacts must belong to the same organisation' using errcode = '22023';
  end if;

  update public.readiness_tasks
    set responsible_contact_id = p_responsible, backup_contact_id = p_backup, updated_at = now()
    where id = p_task_id
    returning * into v_task;
  return v_task;
end $$;

-- --------------------------------------------------------------------------
-- Simulation
-- --------------------------------------------------------------------------

create function private.start_readiness_simulation(p_org_id uuid) returns public.readiness_activations
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.readiness_activations;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not private.is_owner_admin(p_org_id) then
    raise exception 'only an owner admin can start a simulation' using errcode = '42501';
  end if;

  -- A second tap returns the simulation that is already running.
  select * into v_row from public.readiness_activations where owner_org_id = p_org_id and ended_at is null;
  if found then
    return v_row;
  end if;

  if (select count(*) from public.readiness_activations
      where owner_org_id = p_org_id and started_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many simulations started, try again later' using errcode = 'PT429';
  end if;

  insert into public.readiness_activations (owner_org_id, is_simulation, started_by, deadline_at)
  values (p_org_id, true, auth.uid(), now() + interval '48 hours')
  returning * into v_row;
  return v_row;
end $$;

create function private.end_readiness_simulation(p_activation_id uuid) returns public.readiness_activations
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.readiness_activations;
begin
  select * into v_row from public.readiness_activations where id = p_activation_id;
  if not found or not private.is_owner_admin(v_row.owner_org_id) then
    raise exception 'not allowed to end this simulation' using errcode = '42501';
  end if;
  if v_row.ended_at is not null then
    return v_row;
  end if;
  update public.readiness_activations
    set ended_at = now(), ended_by = auth.uid()
    where id = p_activation_id
    returning * into v_row;
  return v_row;
end $$;

create function private.set_readiness_task_done(p_activation_id uuid, p_task_id uuid, p_done boolean)
returns public.readiness_task_completions
language plpgsql security definer set search_path = '' as $$
declare
  v_act  public.readiness_activations;
  v_task public.readiness_tasks;
  v_row  public.readiness_task_completions;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select * into v_act from public.readiness_activations where id = p_activation_id;
  select * into v_task from public.readiness_tasks where id = p_task_id;
  if v_act.id is null or v_task.id is null
     or v_act.owner_org_id <> v_task.owner_org_id
     or not private.is_owner_member(v_act.owner_org_id) then
    raise exception 'not allowed to update this task' using errcode = '42501';
  end if;
  if v_act.ended_at is not null then
    raise exception 'this simulation has ended' using errcode = '22023';
  end if;
  if p_done is null then
    raise exception 'done must be true or false' using errcode = '22023';
  end if;

  if (select count(*) from public.readiness_task_completions
      where updated_by = auth.uid() and updated_at > now() - interval '1 hour') >= 1000 then
    raise exception 'too many updates, try again later' using errcode = 'PT429';
  end if;

  insert into public.readiness_task_completions
    (activation_id, task_id, owner_org_id, shelter_id, done, done_at, done_by, updated_by)
  values
    (p_activation_id, p_task_id, v_task.owner_org_id, v_task.shelter_id, p_done,
     case when p_done then now() end, case when p_done then auth.uid() end, auth.uid())
  on conflict (activation_id, task_id) do update
    set done = excluded.done,
        -- keep the first completion time if it is ticked again
        done_at = case when excluded.done then coalesce(public.readiness_task_completions.done_at, now()) end,
        done_by = case when excluded.done then coalesce(public.readiness_task_completions.done_by, auth.uid()) end,
        updated_at = now(),
        updated_by = auth.uid()
  returning * into v_row;
  return v_row;
end $$;

-- --------------------------------------------------------------------------
-- Data API wrappers
-- --------------------------------------------------------------------------

create function public.setup_readiness_plans(p_org_id uuid, p_shelter_id text default null) returns integer
language sql security invoker set search_path = '' as $$
  select private.setup_readiness_plans(p_org_id, p_shelter_id)
$$;

create function public.save_contact(
  p_id uuid, p_org_id uuid, p_name text, p_phone text, p_email text default null, p_role_note text default ''
) returns public.org_contacts
language sql security invoker set search_path = '' as $$
  select * from private.save_contact(p_id, p_org_id, p_name, p_phone, p_email, p_role_note)
$$;

create function public.delete_contact(p_id uuid) returns void
language sql security invoker set search_path = '' as $$
  select private.delete_contact(p_id)
$$;

create function public.assign_readiness_task(p_task_id uuid, p_responsible uuid, p_backup uuid) returns public.readiness_tasks
language sql security invoker set search_path = '' as $$
  select * from private.assign_readiness_task(p_task_id, p_responsible, p_backup)
$$;

create function public.start_readiness_simulation(p_org_id uuid) returns public.readiness_activations
language sql security invoker set search_path = '' as $$
  select * from private.start_readiness_simulation(p_org_id)
$$;

create function public.end_readiness_simulation(p_activation_id uuid) returns public.readiness_activations
language sql security invoker set search_path = '' as $$
  select * from private.end_readiness_simulation(p_activation_id)
$$;

create function public.set_readiness_task_done(p_activation_id uuid, p_task_id uuid, p_done boolean)
returns public.readiness_task_completions
language sql security invoker set search_path = '' as $$
  select * from private.set_readiness_task_done(p_activation_id, p_task_id, p_done)
$$;

-- --------------------------------------------------------------------------
-- Row-level security: owner organisation only
-- --------------------------------------------------------------------------

alter table public.readiness_task_templates   enable row level security;
alter table public.org_contacts               enable row level security;
alter table public.readiness_tasks            enable row level security;
alter table public.readiness_activations      enable row level security;
alter table public.readiness_task_completions enable row level security;

create policy readiness_task_templates_select on public.readiness_task_templates
  for select to authenticated using (true);

create policy org_contacts_select on public.org_contacts
  for select to authenticated using (owner_org_id in (select private.my_org_ids()));

create policy readiness_tasks_select on public.readiness_tasks
  for select to authenticated using (owner_org_id in (select private.my_org_ids()));

create policy readiness_activations_select on public.readiness_activations
  for select to authenticated using (owner_org_id in (select private.my_org_ids()));

create policy readiness_task_completions_select on public.readiness_task_completions
  for select to authenticated using (owner_org_id in (select private.my_org_ids()));

revoke all on public.readiness_task_templates, public.org_contacts, public.readiness_tasks,
  public.readiness_activations, public.readiness_task_completions from anon, authenticated;
grant select on public.readiness_task_templates, public.org_contacts, public.readiness_tasks,
  public.readiness_activations, public.readiness_task_completions to authenticated;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.setup_readiness_plans(uuid, text)',
    'public.save_contact(uuid, uuid, text, text, text, text)',
    'public.delete_contact(uuid)',
    'public.assign_readiness_task(uuid, uuid, uuid)',
    'public.start_readiness_simulation(uuid)',
    'public.end_readiness_simulation(uuid)',
    'public.set_readiness_task_done(uuid, uuid, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end $$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
