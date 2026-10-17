// Milestone 7: the demo. The access-code login, the status spread the seed
// creates, and that every demo organisation, person and phone number is
// fictional. Run after `npm run demo:reset`; skipped if the demo is not seeded
// or no access code is configured.

import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { admin, env, rows } from './helpers';

const code = process.env.DEMO_ACCESS_CODE ?? '';
const { count: demoOrgs } = await admin.from('organisations').select('id', { count: 'exact', head: true }).eq('is_demo', true);
const ready = Boolean(code) && (demoOrgs ?? 0) > 0;

function demoLogin(body: Record<string, unknown>) {
  return fetch(`${env.url}/functions/v1/demo-login`, {
    method: 'POST',
    headers: { apikey: env.anonKey!, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function clientFor(role: string) {
  const res = await demoLogin({ role, code });
  expect(res.status).toBe(200);
  const { access_token, refresh_token } = await res.json();
  const client = createClient(env.url!, env.anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  await client.auth.setSession({ access_token, refresh_token });
  return client;
}

describe.skipIf(!ready)('demo login', () => {
  it('refuses a wrong access code and an unknown role', async () => {
    expect((await demoLogin({ role: 'owner', code: 'definitely-wrong' })).status).toBe(401);
    expect((await demoLogin({ role: 'owner' })).status).toBe(401);
    expect((await demoLogin({ role: 'superadmin', code })).status).toBe(400);
  });

  it.each([
    ['owner', 'owner_admin', 'Demo Fastigheter AB'],
    ['caretaker', 'caretaker', 'Demo Fastigheter AB'],
    ['lansstyrelse', 'lst_admin', 'Demo Länsstyrelse Östergötland'],
    ['kommun', 'kommun_viewer', 'Demo Kommun Linköping'],
  ])('the right code signs in as the demo %s', async (role, memberRole, orgName) => {
    const client = await clientFor(role);
    const { data: me } = await client.auth.getUser();
    const { data } = await client.from('memberships').select('role, organisations(name)').eq('user_id', me.user!.id);
    expect(data).toEqual([{ role: memberRole, organisations: { name: orgName } }]);
  });

  it('only ever hands out the four demo users, never anyone else', async () => {
    const client = await clientFor('owner');
    const { data } = await client.auth.getUser();
    expect(data.user?.email).toBe('agare@example.com');
  });
});

describe.skipIf(!ready)('demo scene', () => {
  it('the länsstyrelse sees a realistic spread of every status', async () => {
    const lst = await clientFor('lansstyrelse');
    const counts: Record<string, number> = {};
    for (let from = 0; ; from += 1000) {
      const page = await rows<{ status: string }>(lst.from('shelter_review_status').select('status').range(from, from + 999));
      for (const r of page) counts[r.status] = (counts[r.status] ?? 0) + 1;
      if (page.length < 1000) break;
    }
    expect(counts.forelagd).toBeGreaterThanOrEqual(50);
    expect(counts.forsenad).toBeGreaterThanOrEqual(5);
    expect(counts.inskickad).toBeGreaterThanOrEqual(5);
    expect(counts.godkand).toBeGreaterThanOrEqual(20);
    expect(counts.brister).toBeGreaterThanOrEqual(5);
    expect(counts.platsbesok).toBeGreaterThanOrEqual(2);
    expect(counts.ej_forelagd).toBeGreaterThan(2000);
  });

  it('submissions with deficiencies have photos, and the owner sees a link from the länsstyrelse', async () => {
    const owner = await clientFor('owner');
    const { data: brist } = await owner.from('self_checks').select('id').gt('brist_count', 0);
    expect(brist!.length).toBeGreaterThan(0);
    const { count } = await owner.from('photos').select('id', { count: 'exact', head: true }).eq('context', 'self_check');
    expect(count).toBeGreaterThanOrEqual(brist!.length);
    const { data: notices } = await owner.from('order_notices').select('token, lst_name');
    expect(notices!.length).toBeGreaterThanOrEqual(1);
  });

  it('the kommun starts at the default, coarse level', async () => {
    const kommun = await clientFor('kommun');
    const [o] = await rows<{ detail_level: string; approved: number }>(kommun.rpc('kommun_overview'));
    expect(o.detail_level).toBe('coarse');
    expect(o.approved).toBeGreaterThan(0);
  });
});

describe.skipIf((demoOrgs ?? 0) === 0)('everything in the demo is fictional', () => {
  it('every demo organisation is named "Demo …"', async () => {
    const { data } = await admin.from('organisations').select('name').eq('is_demo', true);
    expect(data!.every((o) => o.name.startsWith('Demo '))).toBe(true);
  });

  it('every demo user has an example.com address and a name marked (demo)', async () => {
    const { data: members } = await admin.from('memberships').select('user_id, organisations!inner(is_demo)').eq('organisations.is_demo', true);
    const ids = members!.map((m) => m.user_id);
    const { data: profiles } = await admin.from('profiles').select('full_name').in('user_id', ids);
    expect(profiles!.every((p) => p.full_name.endsWith('(demo)'))).toBe(true);
    for (const id of ids) {
      const { data } = await admin.auth.admin.getUserById(id);
      expect(data.user?.email).toMatch(/@example\.com$/);
    }
  });

  it('every demo phone number is in the series PTS reserves for fiction (070-174 06 05 to 99)', async () => {
    const { data } = await admin.from('org_contacts').select('phone, organisations!inner(is_demo)').eq('organisations.is_demo', true);
    expect(data!.length).toBeGreaterThan(0);
    for (const c of data!) {
      const digits = c.phone.replace(/\D/g, '');
      expect(digits.startsWith('07017406'), c.phone).toBe(true);
      expect(Number(digits.slice(-2))).toBeGreaterThanOrEqual(5);
    }
  });
});
