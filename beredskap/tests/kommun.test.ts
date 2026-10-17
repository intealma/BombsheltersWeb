// Milestone 6: what a kommun sees, at each policy level, and who may change
// the level. Default ("coarse"): a deficient shelter looks exactly like one
// that has not been checked yet.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROOT } from '../scripts/local-env.mjs';
import { admin, createFixtures, rows, signedIn, signInAll, uploadPhoto, type Caller, type Fixtures } from './helpers';

const JPEG = new Uint8Array(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'exif-gps.jpg')));

let fx: Fixtures;
let as: Record<Caller, SupabaseClient>;
let lst05Admin: SupabaseClient;
let lst06Admin: SupabaseClient;
const extraUsers: string[] = [];
const storedPaths: string[] = [];
const checks: Record<'A1' | 'A2' | 'B1', string> = { A1: '', A2: '', B1: '' };
let a2PhotoPath = '';

async function lstAdmin(org: string, label: string) {
  const email = `${label}+${fx.run}@example.org`;
  const { data } = await admin.auth.admin.createUser({ email, password: fx.password, email_confirm: true });
  extraUsers.push(data.user!.id);
  await admin.from('memberships').insert({ user_id: data.user!.id, org_id: org, role: 'lst_admin' });
  return signedIn(email, fx.password);
}

async function submit(caller: Caller, shelterId: string, brist?: string) {
  const { data: tpl } = await admin.from('checklist_templates').select('id, checklist_items(id, key)').eq('active', true).single();
  const id = randomUUID();
  if (brist) {
    const up = await uploadPhoto(as[caller], { shelterId, contextId: id, itemKey: brist, body: JPEG });
    storedPaths.push(up.json.path);
    a2PhotoPath = up.json.path;
  }
  const { error } = await as[caller].rpc('submit_self_check', {
    p_id: id,
    p_shelter_id: shelterId,
    p_template_id: tpl!.id,
    p_inspector_name: 'Test',
    p_started_at: new Date().toISOString(),
    p_answers: (tpl!.checklist_items as { id: string; key: string }[]).map((i) => ({ item_id: i.id, status: i.key === brist ? 'brist' : 'ok', comment: '' })),
  });
  if (error) throw error;
  return id;
}

async function review(checkId: string, decide: (i: number) => string) {
  const { data } = await admin.from('self_check_answers').select('item_id').eq('self_check_id', checkId).order('position');
  const { error } = await as.lst05.rpc('review_self_check', {
    p_self_check_id: checkId,
    p_items: data!.map((a, i) => ({ item_id: a.item_id, decision: decide(i), comment: '' })),
  });
  if (error) throw error;
}

const setLevel = (client: SupabaseClient, org: string, level: string) =>
  client.rpc('set_kommun_policy', { p_kommun_org_id: org, p_level: level });

async function shelterStatuses(caller: Caller) {
  // The API returns at most 1000 rows per request (Norrköping has more), so ask for the test shelters.
  const data = await rows<{ shelter_id: string; status: string; self_check_id: string | null }>(
    as[caller].rpc('kommun_shelters').in('shelter_id', Object.values(fx.shelters)),
  );
  const key = (id: string) => (Object.keys(fx.shelters) as (keyof Fixtures['shelters'])[]).find((k) => fx.shelters[k] === id);
  return Object.fromEntries(data.filter((r) => key(r.shelter_id)).map((r) => [key(r.shelter_id), r])) as Record<
    string,
    { status: string; self_check_id: string | null }
  >;
}

async function canReadDetails(caller: Caller, checkId: string) {
  const [c, a, r] = await Promise.all([
    rows(as[caller].from('self_checks').select('id').eq('id', checkId)),
    rows(as[caller].from('self_check_answers').select('item_id').eq('self_check_id', checkId)),
    rows(as[caller].from('self_check_reviews').select('id').eq('self_check_id', checkId)),
  ]);
  return { checks: c.length, answers: a.length, reviews: r.length };
}

beforeAll(async () => {
  fx = await createFixtures();
  as = await signInAll(fx);
  lst05Admin = await lstAdmin(fx.orgs.lst05, 'lst05admin');
  lst06Admin = await lstAdmin(fx.orgs.lst06, 'lst06admin');

  // A1 approved, A2 with a deficiency, B1 submitted but not reviewed.
  await as.lst05.rpc('create_orders', {
    p_lst_org_id: fx.orgs.lst05,
    p_shelter_ids: [fx.shelters.A1, fx.shelters.A2, fx.shelters.B1],
    p_due_date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date(Date.now() + 30 * 86_400_000)),
  });
  checks.A1 = await submit('caretakerA', fx.shelters.A1);
  checks.A2 = await submit('ownerAdminA', fx.shelters.A2, 'dorr');
  checks.B1 = await submit('ownerAdminB', fx.shelters.B1);
  await review(checks.A1, () => 'godkand');
  await review(checks.A2, (i) => (i === 2 ? 'brist' : 'godkand'));
});

afterAll(async () => {
  if (storedPaths.length) await admin.storage.from('photos').remove(storedPaths);
  for (const id of extraUsers) await admin.auth.admin.deleteUser(id);
  await fx?.cleanup();
});

describe('default policy: coarse', () => {
  it('a kommun sees only Godkänd or Ej godkänd ännu: the deficient shelter looks unchecked', async () => {
    const s = await shelterStatuses('kommun0580');
    expect(Object.keys(s).sort()).toEqual(['A1', 'A2', 'U1']);
    expect(s.A1.status).toBe('godkand');
    expect(s.A2.status).toBe('ej_godkand');
    expect(s.U1.status).toBe('ej_godkand');
    expect(Object.values(s).every((r) => r.self_check_id === null)).toBe(true);
    expect((await shelterStatuses('kommun0581')).B1.status).toBe('ej_godkand');
  });

  it('every status a kommun receives is one of the two coarse values', async () => {
    const all = await rows<{ status: string }>(as.kommun0580.rpc('kommun_shelters'));
    expect(new Set(all.map((r) => r.status)).size).toBeLessThanOrEqual(2);
    expect(all.every((r) => r.status === 'godkand' || r.status === 'ej_godkand')).toBe(true);
  });

  it('the overview gives shares checked and approved for its own kommun only, without status counts', async () => {
    const overview = await rows<Record<string, unknown>>(as.kommun0580.rpc('kommun_overview'));
    expect(overview).toHaveLength(1);
    const o = overview[0];
    expect(o).toMatchObject({ kommun_kod: '0580', detail_level: 'coarse', status_counts: null });
    const all = await rows<{ status: string; capacity: number }>(as.kommun0580.rpc('kommun_shelters'));
    expect(o.shelters).toBe(all.length);
    expect(o.approved).toBe(all.filter((r) => r.status === 'godkand').length);
    expect(Number(o.approved_capacity)).toBe(all.filter((r) => r.status === 'godkand').reduce((n, r) => n + r.capacity, 0));
    expect(o.checked as number).toBeGreaterThanOrEqual(2);
  });

  it('no self-checks, answers, reviews or photos are readable', async () => {
    for (const id of [checks.A1, checks.A2]) expect(await canReadDetails('kommun0580', id)).toEqual({ checks: 0, answers: 0, reviews: 0 });
    expect(await rows(as.kommun0580.from('photos').select('id').eq('shelter_id', fx.shelters.A2))).toEqual([]);
    const signed = await as.kommun0580.storage.from('photos').createSignedUrl(a2PhotoPath, 60);
    expect(signed.error).not.toBeNull();
  });

  it.each(['ownerAdminA', 'caretakerA', 'lst05', 'noOrg'] as const)('%s gets nothing from the kommun functions', async (caller) => {
    expect(await rows(as[caller].rpc('kommun_overview'))).toEqual([]);
    expect(await rows(as[caller].rpc('kommun_shelters'))).toEqual([]);
  });

  it('anonymous callers cannot call the kommun functions', async () => {
    expect((await as.anon.rpc('kommun_overview')).error).not.toBeNull();
    expect((await as.anon.rpc('kommun_shelters')).error).not.toBeNull();
  });
});

describe('changing the policy', () => {
  it.each([
    ['an inspector (not admin)', () => as.lst05],
    ['another län’s admin', () => lst06Admin],
    ['the owner', () => as.ownerAdminA],
    ['the kommun itself', () => as.kommun0580],
    ['an anonymous caller', () => as.anon],
  ])('%s cannot change it', async (_label, client) => {
    expect((await setLevel(client(), fx.orgs.kommun0580, 'details')).error).not.toBeNull();
    expect((await shelterStatuses('kommun0580')).A2.status).toBe('ej_godkand');
  });

  it('rejects an unknown level', async () => {
    expect((await setLevel(lst05Admin, fx.orgs.kommun0580, 'everything')).error?.message).toMatch(/invalid level/);
  });

  it('the länsstyrelse sees the kommun organisations in its län; another län does not', async () => {
    const ids = [fx.orgs.kommun0580, fx.orgs.kommun0581];
    expect(await rows(as.lst05.from('organisations').select('id').in('id', ids))).toHaveLength(2);
    expect(await rows(as.lst06.from('organisations').select('id').in('id', ids))).toEqual([]);
  });
});

describe('policy: status', () => {
  beforeAll(async () => {
    const { error } = await setLevel(lst05Admin, fx.orgs.kommun0580, 'status');
    if (error) throw error;
  });

  it('shows full statuses and counts, still without self-check ids', async () => {
    const s = await shelterStatuses('kommun0580');
    expect(s.A1.status).toBe('godkand');
    expect(s.A2.status).toBe('brister');
    expect(s.A2.self_check_id).toBeNull();
    const [o] = await rows<{ detail_level: string; status_counts: Record<string, number> }>(as.kommun0580.rpc('kommun_overview'));
    expect(o.detail_level).toBe('status');
    expect(o.status_counts.godkand).toBeGreaterThanOrEqual(1);
    expect(o.status_counts.brister).toBeGreaterThanOrEqual(1);
  });

  it('still no answers, reviews or photos', async () => {
    expect(await canReadDetails('kommun0580', checks.A2)).toEqual({ checks: 0, answers: 0, reviews: 0 });
  });

  it('only applies to that kommun', async () => {
    expect((await shelterStatuses('kommun0581')).B1.status).toBe('ej_godkand');
  });
});

describe('policy: details', () => {
  beforeAll(async () => {
    const { error } = await setLevel(lst05Admin, fx.orgs.kommun0580, 'details');
    if (error) throw error;
  });

  it('the kommun can read self-checks, answers, reviews and photos for its own shelters', async () => {
    expect(await canReadDetails('kommun0580', checks.A2)).toMatchObject({ checks: 1, reviews: 1 });
    expect((await canReadDetails('kommun0580', checks.A2)).answers).toBeGreaterThan(0);
    const s = await shelterStatuses('kommun0580');
    expect(s.A2.self_check_id).toBe(checks.A2);
    const signed = await as.kommun0580.storage.from('photos').createSignedUrl(a2PhotoPath, 60);
    expect(signed.error).toBeNull();
    expect((await fetch(signed.data!.signedUrl)).status).toBe(200);
  });

  it('but not for other kommuner, and other kommuner keep the default', async () => {
    expect(await canReadDetails('kommun0580', checks.B1)).toEqual({ checks: 0, answers: 0, reviews: 0 });
    expect(await canReadDetails('kommun0581', checks.A1)).toEqual({ checks: 0, answers: 0, reviews: 0 });
    expect(await canReadDetails('kommun0581', checks.B1)).toEqual({ checks: 0, answers: 0, reviews: 0 });
  });

  it('maintenance photos stay with the owner and the länsstyrelse', async () => {
    const entryId = randomUUID();
    const up = await uploadPhoto(as.ownerAdminA, { shelterId: fx.shelters.A1, contextId: entryId, context: 'maintenance', body: JPEG });
    storedPaths.push(up.json.path);
    expect(await rows(as.kommun0580.from('photos').select('id').eq('context', 'maintenance').eq('shelter_id', fx.shelters.A1))).toEqual([]);
    expect((await as.kommun0580.storage.from('photos').createSignedUrl(up.json.path, 60)).error).not.toBeNull();
  });

  it('the policy row is visible to the kommun and the länsstyrelse, not to owners', async () => {
    expect(await rows(as.kommun0580.from('kommun_policies').select('detail_level'))).toEqual([{ detail_level: 'details' }]);
    expect(await rows(as.lst05.from('kommun_policies').select('detail_level').eq('kommun_org_id', fx.orgs.kommun0580))).toHaveLength(1);
    expect(await rows(as.ownerAdminA.from('kommun_policies').select('detail_level'))).toEqual([]);
  });

  it('every change is in the audit log with who made it', async () => {
    const { data } = await admin.from('audit_log').select('actor_id').eq('table_name', 'kommun_policies').eq('org_id', fx.orgs.kommun0580);
    expect(data!.length).toBe(2);
    const { data: me } = await lst05Admin.auth.getUser();
    expect(data!.every((r) => r.actor_id === me.user!.id)).toBe(true);
  });

  it('setting it back to coarse removes the access again', async () => {
    await setLevel(lst05Admin, fx.orgs.kommun0580, 'coarse');
    expect(await canReadDetails('kommun0580', checks.A2)).toEqual({ checks: 0, answers: 0, reviews: 0 });
    expect((await shelterStatuses('kommun0580')).A2.status).toBe('ej_godkand');
  });
});
