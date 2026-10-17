// Milestone 4: 48-hour readiness plans, contacts and the simulated
// activation. Plans belong to the owner organisation alone.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { admin, ALL_CALLERS, createFixtures, rows, signInAll, type Caller, type Fixtures } from './helpers';

let fx: Fixtures;
let as: Record<Caller, SupabaseClient>;

beforeAll(async () => {
  fx = await createFixtures();
  as = await signInAll(fx);
});

afterAll(async () => {
  await fx?.cleanup();
});

const OWNER_ONLY: Caller[] = ['ownerAdminA', 'caretakerA'];
const OUTSIDERS = ['ownerAdminB', 'lst05', 'lst06', 'kommun0580', 'kommun0581', 'noOrg', 'anon'] as const;

function contact(caller: Caller, overrides: Record<string, unknown> = {}) {
  return as[caller].rpc('save_contact', {
    p_id: randomUUID(),
    p_org_id: fx.orgs.ownerA,
    p_name: 'Test Kontakt',
    p_phone: '070-174 06 05',
    p_email: 'kontakt@example.org',
    p_role_note: 'Fastighetsskötare',
    ...overrides,
  });
}

async function tasksFor(shelterId: string) {
  const { data } = await admin.from('readiness_tasks').select('*').eq('shelter_id', shelterId).order('position');
  return data ?? [];
}

describe('task template', () => {
  it('is readable by signed-in users and lists five placeholder tasks within 48 hours', async () => {
    const data = await rows<{ target_hour: number; is_placeholder: boolean }>(
      as.caretakerA.from('readiness_task_templates').select('target_hour, is_placeholder').eq('active', true),
    );
    expect(data).toHaveLength(5);
    expect(data.every((t) => t.is_placeholder && t.target_hour >= 1 && t.target_hour <= 48)).toBe(true);
    expect(await rows(as.anon.from('readiness_task_templates').select('id'))).toEqual([]);
  });
});

describe('setting up plans', () => {
  it.each(['caretakerA', ...OUTSIDERS] as const)('%s cannot set up owner A’s plans', async (caller) => {
    const { error } = await as[caller].rpc('setup_readiness_plans', { p_org_id: fx.orgs.ownerA });
    expect(error).not.toBeNull();
    expect(await tasksFor(fx.shelters.A1)).toEqual([]);
  });

  it('an owner admin can set up one shelter, then all shelters, without duplicates', async () => {
    const one = await as.ownerAdminA.rpc('setup_readiness_plans', { p_org_id: fx.orgs.ownerA, p_shelter_id: fx.shelters.A1 });
    expect(one.error).toBeNull();
    expect(one.data).toBe(5);
    const all = await as.ownerAdminA.rpc('setup_readiness_plans', { p_org_id: fx.orgs.ownerA });
    expect(all.data).toBe(5); // only A2 was missing
    const again = await as.ownerAdminA.rpc('setup_readiness_plans', { p_org_id: fx.orgs.ownerA });
    expect(again.data).toBe(0);
    expect((await tasksFor(fx.shelters.A1)).map((t) => t.target_hour)).toEqual([6, 24, 36, 40, 44]);
    expect(await tasksFor(fx.shelters.B1)).toEqual([]);
    expect(await tasksFor(fx.shelters.U1)).toEqual([]);
  });

  it('an owner admin cannot set up plans for another organisation', async () => {
    const { error } = await as.ownerAdminA.rpc('setup_readiness_plans', { p_org_id: fx.orgs.ownerB });
    expect(error).not.toBeNull();
    expect(await tasksFor(fx.shelters.B1)).toEqual([]);
  });
});

describe('contacts (personal data)', () => {
  let contactId: string;

  it('an owner admin can add a contact; nobody else can', async () => {
    const ok = await contact('ownerAdminA');
    expect(ok.error).toBeNull();
    contactId = ok.data.id;
    for (const caller of ['caretakerA', ...OUTSIDERS] as const) {
      expect((await contact(caller)).error, caller).not.toBeNull();
    }
  });

  it.each([
    ['a too short name', { p_name: 'A' }, /name/],
    ['a phone number with letters', { p_phone: '070-ABC' }, /phone/],
    ['an invalid email', { p_email: 'not-an-email' }, /email/],
  ])('rejects %s', async (_label, overrides, message) => {
    expect((await contact('ownerAdminA', overrides)).error?.message).toMatch(message);
  });

  it('only the owner organisation can read contacts', async () => {
    for (const caller of ALL_CALLERS) {
      const seen = await rows(as[caller].from('org_contacts').select('id').eq('id', contactId));
      expect(seen.length, caller).toBe(OWNER_ONLY.includes(caller) ? 1 : 0);
    }
  });

  it('an owner admin can update a contact', async () => {
    const { data, error } = await contact('ownerAdminA', { p_id: contactId, p_name: 'Test Kontakt Uppdaterad' });
    expect(error).toBeNull();
    expect(data.name).toBe('Test Kontakt Uppdaterad');
  });

  it('another organisation cannot overwrite the contact by reusing its id', async () => {
    const { error } = await as.ownerAdminB.rpc('save_contact', {
      p_id: contactId, p_org_id: fx.orgs.ownerB, p_name: 'Kapad', p_phone: '070-174 06 06',
    });
    expect(error).not.toBeNull();
    const { data } = await admin.from('org_contacts').select('owner_org_id, name').eq('id', contactId).single();
    expect(data).toEqual({ owner_org_id: fx.orgs.ownerA, name: 'Test Kontakt Uppdaterad' });
  });

  it('the audit log records contact changes without copying the personal data', async () => {
    const { data } = await admin.from('audit_log').select('old_data, new_data, actor_id').eq('table_name', 'org_contacts').eq('row_key', contactId);
    expect(data!.length).toBeGreaterThanOrEqual(2);
    expect(data!.every((r) => r.old_data === null && r.new_data === null && r.actor_id === fx.users.ownerAdminA.id)).toBe(true);
  });
});

describe('assigning responsible and backup', () => {
  let responsible: string;
  let backup: string;
  let otherOrgContact: string;
  let taskId: string;

  beforeAll(async () => {
    await as.ownerAdminA.rpc('setup_readiness_plans', { p_org_id: fx.orgs.ownerA });
    responsible = (await contact('ownerAdminA', { p_name: 'Ansvarig Person', p_phone: '070-174 06 10' })).data.id;
    backup = (await contact('ownerAdminA', { p_name: 'Ersättare Person', p_phone: '070-174 06 11' })).data.id;
    otherOrgContact = (await as.ownerAdminB.rpc('save_contact', {
      p_id: randomUUID(), p_org_id: fx.orgs.ownerB, p_name: 'B Kontakt', p_phone: '070-174 06 12',
    })).data.id;
    taskId = (await tasksFor(fx.shelters.A1))[0].id;
  });

  it('an owner admin assigns two different people from their own organisation', async () => {
    const { data, error } = await as.ownerAdminA.rpc('assign_readiness_task', { p_task_id: taskId, p_responsible: responsible, p_backup: backup });
    expect(error).toBeNull();
    expect(data).toMatchObject({ responsible_contact_id: responsible, backup_contact_id: backup });
  });

  it('rejects the same person twice, or a contact from another organisation', async () => {
    expect((await as.ownerAdminA.rpc('assign_readiness_task', { p_task_id: taskId, p_responsible: responsible, p_backup: responsible })).error?.message).toMatch(/different/);
    expect((await as.ownerAdminA.rpc('assign_readiness_task', { p_task_id: taskId, p_responsible: otherOrgContact, p_backup: null })).error?.message).toMatch(/same organisation/);
  });

  it.each(['caretakerA', ...OUTSIDERS] as const)('%s cannot change assignments', async (caller) => {
    const { error } = await as[caller].rpc('assign_readiness_task', { p_task_id: taskId, p_responsible: null, p_backup: null });
    expect(error).not.toBeNull();
  });

  it('deleting a contact (GDPR) removes it and unassigns it from tasks', async () => {
    expect((await as.caretakerA.rpc('delete_contact', { p_id: backup })).error).not.toBeNull();
    expect((await as.ownerAdminB.rpc('delete_contact', { p_id: backup })).error).not.toBeNull();
    expect((await as.ownerAdminA.rpc('delete_contact', { p_id: backup })).error).toBeNull();
    const { data } = await admin.from('readiness_tasks').select('responsible_contact_id, backup_contact_id').eq('id', taskId).single();
    expect(data).toEqual({ responsible_contact_id: responsible, backup_contact_id: null });
    const { count } = await admin.from('org_contacts').select('id', { count: 'exact', head: true }).eq('id', backup);
    expect(count).toBe(0);
  });

  it('only the owner organisation can read the plan', async () => {
    for (const caller of ALL_CALLERS) {
      const seen = await rows(as[caller].from('readiness_tasks').select('id').in('shelter_id', [fx.shelters.A1, fx.shelters.A2]));
      expect(seen.length, caller).toBe(OWNER_ONLY.includes(caller) ? 10 : 0);
    }
  });
});

describe('the simulated activation', () => {
  let activationId: string;
  let taskId: string;

  beforeAll(async () => {
    await as.ownerAdminA.rpc('setup_readiness_plans', { p_org_id: fx.orgs.ownerA });
    taskId = (await tasksFor(fx.shelters.A2))[1].id;
  });

  it.each(['caretakerA', ...OUTSIDERS] as const)('%s cannot start owner A’s simulation', async (caller) => {
    expect((await as[caller].rpc('start_readiness_simulation', { p_org_id: fx.orgs.ownerA })).error).not.toBeNull();
  });

  it('an owner admin starts it: always a simulation, with a deadline 48 hours later', async () => {
    const { data, error } = await as.ownerAdminA.rpc('start_readiness_simulation', { p_org_id: fx.orgs.ownerA });
    expect(error).toBeNull();
    activationId = data.id;
    expect(data.is_simulation).toBe(true);
    expect(new Date(data.deadline_at).getTime() - new Date(data.started_at).getTime()).toBe(48 * 3600 * 1000);
  });

  it('starting again returns the running simulation instead of a second one', async () => {
    const { data } = await as.ownerAdminA.rpc('start_readiness_simulation', { p_org_id: fx.orgs.ownerA });
    expect(data.id).toBe(activationId);
    const { count } = await admin.from('readiness_activations').select('id', { count: 'exact', head: true }).eq('owner_org_id', fx.orgs.ownerA).is('ended_at', null);
    expect(count).toBe(1);
  });

  it('a real (non-simulation) activation cannot exist, even when inserted by the service role', async () => {
    const { error } = await admin.from('readiness_activations').insert({
      owner_org_id: fx.orgs.ownerB, is_simulation: false, started_by: fx.users.ownerAdminB.id, deadline_at: new Date().toISOString(),
    });
    expect(error?.message).toMatch(/check constraint/);
  });

  it('a caretaker ticks a task off; it is recorded with time and person, and can be unticked', async () => {
    const done = await as.caretakerA.rpc('set_readiness_task_done', { p_activation_id: activationId, p_task_id: taskId, p_done: true });
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({ done: true, done_by: fx.users.caretakerA.id, shelter_id: fx.shelters.A2 });
    expect(done.data.done_at).not.toBeNull();

    const undone = await as.ownerAdminA.rpc('set_readiness_task_done', { p_activation_id: activationId, p_task_id: taskId, p_done: false });
    expect(undone.data).toMatchObject({ done: false, done_at: null, updated_by: fx.users.ownerAdminA.id });

    await as.caretakerA.rpc('set_readiness_task_done', { p_activation_id: activationId, p_task_id: taskId, p_done: true });
  });

  it.each(OUTSIDERS)('%s cannot tick owner A’s tasks', async (caller) => {
    const { error } = await as[caller].rpc('set_readiness_task_done', { p_activation_id: activationId, p_task_id: taskId, p_done: false });
    expect(error).not.toBeNull();
  });

  it('a task from one organisation cannot be ticked in another organisation’s simulation', async () => {
    await as.ownerAdminB.rpc('setup_readiness_plans', { p_org_id: fx.orgs.ownerB });
    const bTask = (await tasksFor(fx.shelters.B1))[0].id;
    expect((await as.caretakerA.rpc('set_readiness_task_done', { p_activation_id: activationId, p_task_id: bTask, p_done: true })).error).not.toBeNull();
    expect((await as.ownerAdminB.rpc('set_readiness_task_done', { p_activation_id: activationId, p_task_id: bTask, p_done: true })).error).not.toBeNull();
  });

  it('only the owner organisation sees the simulation and its progress', async () => {
    for (const caller of ALL_CALLERS) {
      const acts = await rows(as[caller].from('readiness_activations').select('id').eq('id', activationId));
      const comps = await rows(as[caller].from('readiness_task_completions').select('task_id').eq('activation_id', activationId));
      const expected = OWNER_ONLY.includes(caller) ? 1 : 0;
      expect(acts.length, caller).toBe(expected);
      expect(comps.length, caller).toBe(expected);
    }
  });

  it('only an owner admin can end it, and nothing can be ticked afterwards', async () => {
    expect((await as.caretakerA.rpc('end_readiness_simulation', { p_activation_id: activationId })).error).not.toBeNull();
    expect((await as.ownerAdminB.rpc('end_readiness_simulation', { p_activation_id: activationId })).error).not.toBeNull();
    const ended = await as.ownerAdminA.rpc('end_readiness_simulation', { p_activation_id: activationId });
    expect(ended.data.ended_by).toBe(fx.users.ownerAdminA.id);
    const late = await as.caretakerA.rpc('set_readiness_task_done', { p_activation_id: activationId, p_task_id: taskId, p_done: false });
    expect(late.error?.message).toMatch(/ended/);
  });

  it('every step is in the audit log with who did it', async () => {
    const { data } = await admin.from('audit_log').select('table_name, actor_id').eq('org_id', fx.orgs.ownerA)
      .in('table_name', ['readiness_activations', 'readiness_task_completions']);
    expect(data!.some((r) => r.table_name === 'readiness_activations' && r.actor_id === fx.users.ownerAdminA.id)).toBe(true);
    expect(data!.some((r) => r.table_name === 'readiness_task_completions' && r.actor_id === fx.users.caretakerA.id)).toBe(true);
  });
});

describe('no direct writes', () => {
  it('no caller can write plan, contact, activation or completion tables directly', async () => {
    for (const caller of ALL_CALLERS) {
      for (const table of ['readiness_tasks', 'org_contacts', 'readiness_activations', 'readiness_task_completions', 'readiness_task_templates']) {
        const { error } = await as[caller].from(table).insert({ id: randomUUID() });
        expect(error, `${caller} ${table}`).not.toBeNull();
      }
      await as[caller].from('readiness_tasks').update({ target_hour: 1 }).eq('shelter_id', fx.shelters.A1);
      await as[caller].from('readiness_activations').update({ ended_at: null }).eq('owner_org_id', fx.orgs.ownerA);
    }
    expect((await tasksFor(fx.shelters.A1)).map((t) => t.target_hour)).toEqual([6, 24, 36, 40, 44]);
    const { data } = await admin.from('readiness_activations').select('ended_at').eq('owner_org_id', fx.orgs.ownerA);
    expect(data!.every((a) => a.ended_at !== null)).toBe(true);
  });
});
