// Milestone 2: self-checks and photos. Who may submit, what a valid
// submission is, that photos lose their metadata, who may see the results,
// and that nothing can be changed afterwards.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROOT } from '../scripts/local-env.mjs';
import { admin, ALL_CALLERS, createFixtures, rows, signInAll, uploadPhoto, type Caller, type Fixtures } from './helpers';

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(ROOT, 'tests', 'fixtures', name)));
const EXIF_JPEG = fixture('exif-gps.jpg');
const PROGRESSIVE_JPEG = fixture('exif-gps-progressive.jpg');

let fx: Fixtures;
let as: Record<Caller, SupabaseClient>;
let template: { id: string; items: { id: string; key: string }[] };
const storedPaths: string[] = [];

beforeAll(async () => {
  fx = await createFixtures();
  as = await signInAll(fx);
  const { data, error } = await admin
    .from('checklist_templates')
    .select('id, checklist_items(id, key, position)')
    .eq('key', 'forenklad-kontroll')
    .eq('active', true)
    .single();
  if (error) throw error;
  const items = (data.checklist_items as { id: string; key: string; position: number }[]).sort((a, b) => a.position - b.position);
  template = { id: data.id, items };
});

afterAll(async () => {
  if (storedPaths.length) await admin.storage.from('photos').remove(storedPaths);
  await fx?.cleanup();
});

type Status = 'ok' | 'brist' | 'ej_tillampligt';

function answers(overrides: Record<string, Status> = {}) {
  return template.items.map((i) => ({ item_id: i.id, status: overrides[i.key] ?? 'ok', comment: '' }));
}

function submit(caller: Caller, shelterId: string, opts: { id?: string; answers?: unknown; name?: string } = {}) {
  return as[caller].rpc('submit_self_check', {
    p_id: opts.id ?? randomUUID(),
    p_shelter_id: shelterId,
    p_template_id: template.id,
    p_inspector_name: opts.name ?? 'Test Inspektör',
    p_started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    p_answers: opts.answers ?? answers(),
  });
}

async function upload(
  caller: Caller,
  params: { shelterId: string; contextId: string; itemKey?: string; photoId?: string; body?: Uint8Array; contentType?: string },
) {
  const res = await uploadPhoto(caller === 'anon' ? null : as[caller], { ...params, body: params.body ?? EXIF_JPEG });
  if (res.status === 201) storedPaths.push(res.json.path);
  return res;
}

const ascii = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

describe('checklist', () => {
  it('the active checklist is the 7-item placeholder, readable by signed-in users', async () => {
    const { data } = await as.kommun0580
      .from('checklist_templates')
      .select('is_placeholder, checklist_items(key)')
      .eq('id', template.id)
      .single();
    expect(data!.is_placeholder).toBe(true);
    expect((data!.checklist_items as unknown[]).length).toBe(7);
  });

  it('is not readable anonymously', async () => {
    expect(await rows(as.anon.from('checklist_templates').select('id'))).toEqual([]);
    expect(await rows(as.anon.from('checklist_items').select('id'))).toEqual([]);
  });
});

describe('who may submit', () => {
  it('owner admin and caretaker can submit for their own shelters', async () => {
    const a = await submit('ownerAdminA', fx.shelters.A1);
    expect(a.error).toBeNull();
    expect(a.data).toMatchObject({ shelter_id: fx.shelters.A1, owner_org_id: fx.orgs.ownerA, ok_count: 7, brist_count: 0, na_count: 0 });
    expect(a.data.submitted_by).toBe(fx.users.ownerAdminA.id);

    const c = await submit('caretakerA', fx.shelters.A2, { answers: answers({ golvbrunn: 'ej_tillampligt' }) });
    expect(c.error).toBeNull();
    expect(c.data).toMatchObject({ ok_count: 6, na_count: 1 });
  });

  it.each(['ownerAdminB', 'lst05', 'lst06', 'kommun0580', 'noOrg', 'anon'] as const)('%s cannot submit for owner A’s shelter', async (caller) => {
    const { error } = await submit(caller, fx.shelters.A1);
    expect(error).not.toBeNull();
  });

  it('nobody can submit for a shelter without an owner', async () => {
    for (const caller of ['ownerAdminA', 'lst05', 'kommun0580'] as const) {
      expect((await submit(caller, fx.shelters.U1)).error, caller).not.toBeNull();
    }
  });

  it('a retried submit returns the stored check instead of a duplicate; nobody else can reuse the id', async () => {
    const id = randomUUID();
    const first = await submit('ownerAdminA', fx.shelters.A1, { id });
    const again = await submit('ownerAdminA', fx.shelters.A1, { id, name: 'Changed Name' });
    expect(again.error).toBeNull();
    expect(again.data.submitted_at).toBe(first.data.submitted_at);
    expect(again.data.inspector_name).toBe('Test Inspektör');
    const { count } = await admin.from('self_checks').select('id', { count: 'exact', head: true }).eq('id', id);
    expect(count).toBe(1);

    expect((await submit('caretakerA', fx.shelters.A1, { id })).error).not.toBeNull();
  });
});

describe('what a valid submission is', () => {
  const bad: [string, () => unknown, RegExp][] = [
    ['an item is missing', () => answers().slice(1), /every checklist item/],
    ['an item appears twice', () => { const a = answers(); a[1] = { ...a[0] }; return a; }, /every checklist item/],
    ['an unknown item is included', () => { const a = answers(); a[0] = { ...a[0], item_id: randomUUID() }; return a; }, /every checklist item/],
    ['a status is invalid', () => { const a = answers(); (a[0] as { status: string }).status = 'maybe'; return a; }, /invalid status/],
    ['a comment is too long', () => { const a = answers(); a[0].comment = 'x'.repeat(2001); return a; }, /too long/],
    ['answers are not an array', () => ({ nope: true }), /array/],
  ];

  it.each(bad)('rejected when %s', async (_label, make, message) => {
    const { error } = await submit('ownerAdminA', fx.shelters.A1, { answers: make() });
    expect(error?.message).toMatch(message);
  });

  it('rejected when the inspector name is missing', async () => {
    const { error } = await submit('ownerAdminA', fx.shelters.A1, { name: ' ' });
    expect(error?.message).toMatch(/inspector name/);
  });

  it('a deficiency without a stored photo is rejected', async () => {
    const { error } = await submit('ownerAdminA', fx.shelters.A1, { answers: answers({ dorr: 'brist' }) });
    expect(error?.message).toMatch(/photo is required/);
  });
});

describe('photos', () => {
  it('metadata is stripped on upload (EXIF, GPS, camera model, comments, trailing data)', async () => {
    for (const body of [EXIF_JPEG, PROGRESSIVE_JPEG]) {
      const res = await upload('ownerAdminA', { shelterId: fx.shelters.A1, contextId: randomUUID(), itemKey: 'skylt', body });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ width: 64, height: 48 });

      const { data: blob } = await admin.storage.from('photos').download(res.json.path);
      const stored = new Uint8Array(await blob!.arrayBuffer());
      const text = ascii(stored);
      expect(stored[0]).toBe(0xff);
      expect(stored[1]).toBe(0xd8);
      expect(stored.at(-2)).toBe(0xff);
      expect(stored.at(-1)).toBe(0xd9);
      for (const secret of ['Exif', 'TestCam', 'SerialModel', 'secret comment', 'TRAILER']) {
        expect(text.includes(secret), secret).toBe(false);
      }
      expect(ascii(body).includes('Exif')).toBe(true); // the original really had it
    }
  });

  it('a deficiency with a stored photo is accepted', async () => {
    const checkId = randomUUID();
    expect((await upload('caretakerA', { shelterId: fx.shelters.A2, contextId: checkId, itemKey: 'dorr' })).status).toBe(201);
    const { data, error } = await submit('caretakerA', fx.shelters.A2, { id: checkId, answers: answers({ dorr: 'brist' }) });
    expect(error).toBeNull();
    expect(data.brist_count).toBe(1);
  });

  it('a photo for a different item does not satisfy the deficiency', async () => {
    const checkId = randomUUID();
    await upload('ownerAdminA', { shelterId: fx.shelters.A1, contextId: checkId, itemKey: 'skylt' });
    const { error } = await submit('ownerAdminA', fx.shelters.A1, { id: checkId, answers: answers({ dorr: 'brist' }) });
    expect(error?.message).toMatch(/photo is required/);
  });

  it('no photos can be added to a check after it was submitted', async () => {
    const checkId = randomUUID();
    await submit('ownerAdminA', fx.shelters.A1, { id: checkId });
    const res = await upload('ownerAdminA', { shelterId: fx.shelters.A1, contextId: checkId, itemKey: 'skylt' });
    expect(res.status).toBe(400);
  });

  it.each([
    ['ownerAdminB', 403],
    ['lst05', 403],
    ['kommun0580', 403],
    ['noOrg', 403],
    ['anon', 401],
  ] as const)('%s cannot upload photos for owner A’s shelter', async (caller, status) => {
    const res = await upload(caller, { shelterId: fx.shelters.A1, contextId: randomUUID(), itemKey: 'skylt' });
    expect(res.status).toBe(status);
  });

  it('only JPEG is accepted, and parameters are validated', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect((await upload('ownerAdminA', { shelterId: fx.shelters.A1, contextId: randomUUID(), body: png })).status).toBe(415);
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    expect((await upload('ownerAdminA', { shelterId: fx.shelters.A1, contextId: randomUUID(), body: html })).status).toBe(415);
    expect((await upload('ownerAdminA', { shelterId: fx.shelters.A1, contextId: 'not-a-uuid' })).status).toBe(400);
    expect((await upload('ownerAdminA', { shelterId: "A1'; drop table", contextId: randomUUID() })).status).toBe(400);
  });

  describe('signed URLs', () => {
    let photoPath: string;

    beforeAll(async () => {
      const res = await upload('ownerAdminA', { shelterId: fx.shelters.A1, contextId: randomUUID(), itemKey: 'skylt' });
      photoPath = res.json.path;
    });

    it.each(['ownerAdminA', 'caretakerA', 'lst05'] as const)('%s can get a short-lived link and load the photo', async (caller) => {
      const { data, error } = await as[caller].storage.from('photos').createSignedUrl(photoPath, 60);
      expect(error).toBeNull();
      const res = await fetch(data!.signedUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/image\/jpeg/);
    });

    it.each(['ownerAdminB', 'lst06', 'kommun0580', 'kommun0581', 'noOrg', 'anon'] as const)('%s cannot get a link', async (caller) => {
      const { data, error } = await as[caller].storage.from('photos').createSignedUrl(photoPath, 60);
      expect(error).not.toBeNull();
      expect(data).toBeNull();
    });

    it('the bucket is private: the public URL does not serve the file', async () => {
      const { data } = admin.storage.from('photos').getPublicUrl(photoPath);
      const res = await fetch(data.publicUrl);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('nobody can upload, overwrite or delete files directly in storage', async () => {
      for (const caller of ALL_CALLERS) {
        const up = await as[caller].storage.from('photos').upload(`${fx.shelters.A1}/x/${randomUUID()}.jpg`, EXIF_JPEG, { contentType: 'image/jpeg' });
        expect(up.error, `${caller} upload`).not.toBeNull();
        await as[caller].storage.from('photos').remove([photoPath]);
      }
      const { data } = await admin.storage.from('photos').download(photoPath);
      expect(data).not.toBeNull();
    });
  });
});

describe('who can see submitted checks', () => {
  const expectSees: Record<Caller, boolean> = {
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

  it.each(ALL_CALLERS)('%s', async (caller) => {
    const checks = await rows<{ id: string }>(
      as[caller].from('self_checks').select('id').in('shelter_id', [fx.shelters.A1, fx.shelters.A2]),
    );
    const ids = checks.map((c) => c.id);
    const answersSeen = ids.length
      ? await rows(as[caller].from('self_check_answers').select('self_check_id').in('self_check_id', ids))
      : await rows(as[caller].from('self_check_answers').select('self_check_id').limit(1));
    const photos = await rows(as[caller].from('photos').select('id').in('shelter_id', [fx.shelters.A1, fx.shelters.A2]));
    if (expectSees[caller]) {
      expect(ids.length).toBeGreaterThan(0);
      expect(answersSeen.length).toBe(ids.length * 7);
      expect(photos.length).toBeGreaterThan(0);
    } else {
      expect(ids).toEqual([]);
      expect(photos).toEqual([]);
    }
  });

  it('kommuner and owners see no answers of checks outside their reach', async () => {
    const { data: all } = await admin.from('self_checks').select('id').in('shelter_id', [fx.shelters.A1, fx.shelters.A2]);
    const ids = all!.map((c) => c.id);
    for (const caller of ['ownerAdminB', 'kommun0580', 'lst06', 'noOrg', 'anon'] as const) {
      expect(await rows(as[caller].from('self_check_answers').select('self_check_id').in('self_check_id', ids)), caller).toEqual([]);
    }
  });
});

describe('submitted checks cannot be changed', () => {
  it('no caller can insert, update or delete checks, answers or photo records directly', async () => {
    const { data: check } = await admin.from('self_checks').select('*').eq('shelter_id', fx.shelters.A1).limit(1).single();
    for (const caller of ALL_CALLERS) {
      const ins = await as[caller].from('self_checks').insert({ ...check, id: randomUUID() });
      expect(ins.error, `${caller} insert`).not.toBeNull();
      await as[caller].from('self_checks').update({ brist_count: 99 }).eq('id', check!.id);
      await as[caller].from('self_checks').delete().eq('id', check!.id);
      await as[caller].from('self_check_answers').update({ status: 'ok' }).eq('self_check_id', check!.id);
      await as[caller].from('photos').delete().eq('shelter_id', fx.shelters.A1);
    }
    const { data: after } = await admin.from('self_checks').select('*').eq('id', check!.id).single();
    expect(after).toEqual(check);
  });

  it('even the service role cannot rewrite a submitted check', async () => {
    const { data: check } = await admin.from('self_checks').select('id').eq('shelter_id', fx.shelters.A1).limit(1).single();
    const { error } = await admin.from('self_checks').update({ brist_count: 99 }).eq('id', check!.id);
    expect(error?.message).toMatch(/cannot be changed/);
  });

  it('every submission is in the audit log, attributed to the person who submitted it', async () => {
    const { data } = await admin
      .from('audit_log')
      .select('actor_id, actor_role, action')
      .eq('table_name', 'self_checks')
      .eq('shelter_id', fx.shelters.A2);
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((r) => r.actor_id === fx.users.caretakerA.id && r.actor_role === 'authenticated' && r.action === 'insert')).toBe(true);
  });
});

describe('rate limiting', () => {
  it('stops a user after 20 submissions in an hour', async () => {
    for (let i = 0; i < 20; i++) {
      const { error } = await submit('ownerAdminB', fx.shelters.B1);
      expect(error, `submission ${i + 1}`).toBeNull();
    }
    const { error } = await submit('ownerAdminB', fx.shelters.B1);
    expect(error?.code).toBe('PT429');
  });
});
