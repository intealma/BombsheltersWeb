// Milestone 3: the maintenance log. Who may log and void entries, what a
// valid entry is, who can read the log, and that it cannot be rewritten.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROOT } from '../scripts/local-env.mjs';
import { admin, ALL_CALLERS, createFixtures, rows, signInAll, uploadPhoto, type Caller, type Fixtures } from './helpers';

const JPEG = new Uint8Array(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'exif-gps.jpg')));

let fx: Fixtures;
let as: Record<Caller, SupabaseClient>;
const storedPaths: string[] = [];

beforeAll(async () => {
  fx = await createFixtures();
  as = await signInAll(fx);
});

afterAll(async () => {
  if (storedPaths.length) await admin.storage.from('photos').remove(storedPaths);
  await fx?.cleanup();
});

/** Today in Swedish time, as YYYY-MM-DD, offset by `days`. */
function day(days = 0): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(d);
}

function add(caller: Caller, shelterId: string, overrides: Record<string, unknown> = {}) {
  return as[caller].rpc('add_maintenance_entry', {
    p_id: randomUUID(),
    p_shelter_id: shelterId,
    p_performed_on: day(-3),
    p_category: 'ventilation',
    p_description: 'Bytt filter i ventilationsaggregatet.',
    p_performed_by: 'Test Fastighetsservice AB',
    ...overrides,
  });
}

async function upload(caller: Caller, shelterId: string, entryId: string) {
  const res = await uploadPhoto(caller === 'anon' ? null : as[caller], {
    shelterId,
    contextId: entryId,
    context: 'maintenance',
    body: JPEG,
  });
  if (res.status === 201) storedPaths.push(res.json.path);
  return res;
}

describe('who may log maintenance', () => {
  it('owner admin and caretaker can log for their own shelters', async () => {
    const a = await add('ownerAdminA', fx.shelters.A1);
    expect(a.error).toBeNull();
    expect(a.data).toMatchObject({ shelter_id: fx.shelters.A1, owner_org_id: fx.orgs.ownerA, category: 'ventilation' });
    expect(a.data.registered_by).toBe(fx.users.ownerAdminA.id);
    expect((await add('caretakerA', fx.shelters.A2, { p_category: 'rensning' })).error).toBeNull();
  });

  it.each(['ownerAdminB', 'lst05', 'lst06', 'kommun0580', 'noOrg', 'anon'] as const)('%s cannot log for owner A’s shelter', async (caller) => {
    expect((await add(caller, fx.shelters.A1)).error).not.toBeNull();
  });

  it('nobody can log for a shelter without an owner', async () => {
    expect((await add('ownerAdminA', fx.shelters.U1)).error).not.toBeNull();
  });

  it('a retried save returns the stored entry instead of a duplicate', async () => {
    const id = randomUUID();
    const first = await add('caretakerA', fx.shelters.A1, { p_id: id });
    const again = await add('caretakerA', fx.shelters.A1, { p_id: id, p_description: 'Something else entirely' });
    expect(again.data.created_at).toBe(first.data.created_at);
    expect(again.data.description).toBe(first.data.description);
    expect((await add('ownerAdminA', fx.shelters.A1, { p_id: id })).error).not.toBeNull();
  });
});

describe('what a valid entry is', () => {
  it.each([
    ['a date in the future', { p_performed_on: day(1) }, /date/],
    ['a date more than two years ago', { p_performed_on: day(-800) }, /date/],
    ['an unknown category', { p_category: 'magic' }, /category/],
    ['an empty description', { p_description: '  ' }, /describe/],
    ['a description that is too long', { p_description: 'x'.repeat(4001) }, /describe/],
    ['no one named as doing the work', { p_performed_by: '' }, /who did/],
  ])('rejected: %s', async (_label, overrides, message) => {
    const { error } = await add('ownerAdminA', fx.shelters.A1, overrides);
    expect(error?.message).toMatch(message);
  });

  it('today is accepted, and control characters are stripped', async () => {
    const { data, error } = await add('ownerAdminA', fx.shelters.A1, {
      p_performed_on: day(0),
      p_description: 'Rad ett\nRad två\u0007\u001b',
    });
    expect(error).toBeNull();
    expect(data.description).toBe('Rad ett\nRad två');
  });
});

describe('photos on entries', () => {
  it('can be added before saving, and are stored without metadata', async () => {
    const entryId = randomUUID();
    const res = await upload('caretakerA', fx.shelters.A2, entryId);
    expect(res.status).toBe(201);
    expect(res.json.path).toContain('/maintenance/');
    expect((await add('caretakerA', fx.shelters.A2, { p_id: entryId })).error).toBeNull();

    const { data: blob } = await admin.storage.from('photos').download(res.json.path);
    const text = Buffer.from(await blob!.arrayBuffer()).toString('latin1');
    expect(text.includes('Exif')).toBe(false);
  });

  it('cannot be added once the entry is saved', async () => {
    const entryId = randomUUID();
    await add('ownerAdminA', fx.shelters.A1, { p_id: entryId });
    expect((await upload('ownerAdminA', fx.shelters.A1, entryId)).status).toBe(400);
  });

  it.each([['ownerAdminB', 403], ['lst05', 403], ['kommun0580', 403], ['anon', 401]] as const)(
    '%s cannot add photos to owner A’s entries',
    async (caller, status) => {
      expect((await upload(caller, fx.shelters.A1, randomUUID())).status).toBe(status);
    },
  );
});

describe('who can read the log', () => {
  const sees: Record<Caller, boolean> = {
    ownerAdminA: true,
    caretakerA: true,
    ownerAdminB: false,
    lst05: true,
    lst06: false,
    kommun0580: false,
    kommun0581: false,
    noOrg: false,
    anon: false,
  };

  // Own data, so this block also works when run on its own.
  beforeAll(async () => {
    const entryId = randomUUID();
    await upload('caretakerA', fx.shelters.A2, entryId);
    await add('caretakerA', fx.shelters.A2, { p_id: entryId });
    await add('ownerAdminA', fx.shelters.A1);
  });

  it.each(ALL_CALLERS)('%s', async (caller) => {
    const entries = await rows(as[caller].from('maintenance_entries').select('id').in('shelter_id', [fx.shelters.A1, fx.shelters.A2]));
    const photos = await rows(as[caller].from('photos').select('id').eq('context', 'maintenance').in('shelter_id', [fx.shelters.A2]));
    if (sees[caller]) {
      expect(entries.length).toBeGreaterThan(0);
      expect(photos.length).toBeGreaterThan(0);
    } else {
      expect(entries).toEqual([]);
      expect(photos).toEqual([]);
    }
  });
});

describe('voiding (makulering)', () => {
  let entryId: string;

  beforeAll(async () => {
    entryId = randomUUID();
    await add('caretakerA', fx.shelters.A1, { p_id: entryId, p_description: 'Fel skyddsrum, ska makuleras.' });
  });

  it.each(['caretakerA', 'ownerAdminB', 'lst05', 'kommun0580', 'noOrg', 'anon'] as const)('%s cannot void owner A’s entry', async (caller) => {
    const { error } = await as[caller].rpc('void_maintenance_entry', { p_entry_id: entryId, p_reason: 'Testar' });
    expect(error).not.toBeNull();
  });

  it('needs a reason', async () => {
    const { error } = await as.ownerAdminA.rpc('void_maintenance_entry', { p_entry_id: entryId, p_reason: ' ' });
    expect(error?.message).toMatch(/reason/);
  });

  it('an owner admin can void with a reason; the entry stays and is marked', async () => {
    const { data, error } = await as.ownerAdminA.rpc('void_maintenance_entry', { p_entry_id: entryId, p_reason: 'Registrerad på fel skyddsrum.' });
    expect(error).toBeNull();
    expect(data).toMatchObject({ entry_id: entryId, voided_by: fx.users.ownerAdminA.id });

    const { data: entry } = await as.caretakerA
      .from('maintenance_entries')
      .select('id, description, maintenance_voids(reason)')
      .eq('id', entryId)
      .single();
    expect(entry!.description).toBe('Fel skyddsrum, ska makuleras.');
    expect(entry!.maintenance_voids).toMatchObject({ reason: 'Registrerad på fel skyddsrum.' });
    expect(await rows(as.lst05.from('maintenance_voids').select('entry_id').eq('entry_id', entryId))).toHaveLength(1);
    expect(await rows(as.ownerAdminB.from('maintenance_voids').select('entry_id').eq('entry_id', entryId))).toEqual([]);
  });

  it('cannot be voided twice', async () => {
    const { error } = await as.ownerAdminA.rpc('void_maintenance_entry', { p_entry_id: entryId, p_reason: 'Igen' });
    expect(error?.message).toMatch(/already voided/);
  });
});

describe('the log cannot be rewritten', () => {
  it('no caller can insert, update or delete entries or voids directly', async () => {
    const { data: entry } = await admin.from('maintenance_entries').select('*').eq('shelter_id', fx.shelters.A1).limit(1).single();
    for (const caller of ALL_CALLERS) {
      const ins = await as[caller].from('maintenance_entries').insert({ ...entry, id: randomUUID() });
      expect(ins.error, `${caller} insert`).not.toBeNull();
      await as[caller].from('maintenance_entries').update({ performed_on: day(-400) }).eq('id', entry!.id);
      await as[caller].from('maintenance_entries').delete().eq('id', entry!.id);
      await as[caller].from('maintenance_voids').delete().eq('shelter_id', fx.shelters.A1);
    }
    const { data: after } = await admin.from('maintenance_entries').select('*').eq('id', entry!.id).single();
    expect(after).toEqual(entry);
  });

  it('even the service role cannot change an entry’s date or text', async () => {
    const { data: entry } = await admin.from('maintenance_entries').select('id').eq('shelter_id', fx.shelters.A1).limit(1).single();
    const { error } = await admin.from('maintenance_entries').update({ performed_on: day(-400) }).eq('id', entry!.id);
    expect(error?.message).toMatch(/cannot be changed/);
  });

  it('entries and voids are in the audit log with who registered them', async () => {
    const { data } = await admin
      .from('audit_log')
      .select('table_name, actor_id, actor_role')
      .eq('shelter_id', fx.shelters.A1)
      .in('table_name', ['maintenance_entries', 'maintenance_voids']);
    expect(data!.some((r) => r.table_name === 'maintenance_entries' && r.actor_id === fx.users.caretakerA.id)).toBe(true);
    expect(data!.some((r) => r.table_name === 'maintenance_voids' && r.actor_id === fx.users.ownerAdminA.id)).toBe(true);
    expect(data!.every((r) => r.actor_role === 'authenticated')).toBe(true);
  });
});

describe('rate limiting', () => {
  it('stops a user after 60 entries in an hour', async () => {
    for (let i = 0; i < 60; i++) {
      const { error } = await add('ownerAdminB', fx.shelters.B1);
      expect(error, `entry ${i + 1}`).toBeNull();
    }
    expect((await add('ownerAdminB', fx.shelters.B1)).error?.code).toBe('PT429');
  });
});
