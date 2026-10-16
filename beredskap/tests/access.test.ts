// Proves that each role can only read its own organisation's data, and that
// nobody can grant themselves access by writing to the API. Runs against the
// local Supabase stack: npm run db:start, then npm test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { admin, anonClient, createFixtures, ROLES, signedIn, type Fixtures, type RoleKey } from './helpers';

let fx: Fixtures;
const as = {} as Record<RoleKey | 'anon', SupabaseClient>;

beforeAll(async () => {
  fx = await createFixtures();
  for (const key of ROLES) as[key] = await signedIn(fx.users[key].email, fx.password);
  as.anon = anonClient();
});

afterAll(async () => {
  await fx?.cleanup();
});

const ALL_CALLERS = [...ROLES, 'anon'] as const;

/** Rows a caller can read, or [] when the request is refused outright. */
async function rows<T = Record<string, unknown>>(query: PromiseLike<{ data: T[] | null; error: unknown }>) {
  const { data } = await query;
  return data ?? [];
}

const testShelterIds = () => Object.values(fx.shelters);
const shelterKey = (id: string) => (Object.keys(fx.shelters) as (keyof Fixtures['shelters'])[]).find((k) => fx.shelters[k] === id);
const orgKey = (id: string) => (Object.keys(fx.orgs) as (keyof Fixtures['orgs'])[]).find((k) => fx.orgs[k] === id);
const userKey = (id: string) => ROLES.find((k) => fx.users[k].id === id);

async function adminCount(column: string, value: string) {
  const { count, error } = await admin.from('shelters').select('id', { count: 'exact', head: true }).eq(column, value);
  if (error) throw error;
  return count ?? 0;
}

async function visibleCount(caller: SupabaseClient, filter?: (q: any) => any) {
  let q = caller.from('shelters').select('id', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count } = await q;
  return count ?? 0;
}

describe('authentication', () => {
  it('anonymous sign-in is disabled', async () => {
    const { data, error } = await anonClient().auth.signInAnonymously();
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it('self sign-up is disabled', async () => {
    const { data, error } = await anonClient().auth.signUp({
      email: `intruder+${fx.run}@example.org`,
      password: 'Intruder-Password-123',
    });
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it('a wrong password is rejected', async () => {
    const { error } = await anonClient().auth.signInWithPassword({ email: fx.users.ownerAdminA.email, password: 'Wrong-Password-123' });
    expect(error).not.toBeNull();
  });
});

describe('shelters: each role sees only its scope', () => {
  const expected: Record<RoleKey | 'anon', string[]> = {
    ownerAdminA: ['A1', 'A2'],
    caretakerA: ['A1', 'A2'],
    ownerAdminB: ['B1'],
    lst05: ['A1', 'A2', 'B1', 'U1'],
    lst06: ['J1'],
    kommun0580: ['A1', 'A2', 'U1'],
    kommun0581: ['B1'],
    noOrg: [],
    anon: [],
  };

  it.each(ALL_CALLERS)('%s', async (caller) => {
    const data = await rows<{ id: string }>(as[caller].from('shelters').select('id').in('id', testShelterIds()));
    expect(data.map((r) => shelterKey(r.id)).sort()).toEqual(expected[caller]);
  });

  it('owners see nothing beyond their assigned shelters', async () => {
    expect(await visibleCount(as.ownerAdminA)).toBe(2);
    expect(await visibleCount(as.caretakerA)).toBe(2);
    expect(await visibleCount(as.ownerAdminB)).toBe(1);
  });

  it('a länsstyrelse sees every shelter in its län and none outside it', async () => {
    expect(await visibleCount(as.lst05)).toBe(await adminCount('lan_kod', '05'));
    expect(await visibleCount(as.lst05, (q) => q.neq('lan_kod', '05'))).toBe(0);
    expect(await visibleCount(as.lst06)).toBe(await adminCount('lan_kod', '06'));
    expect(await visibleCount(as.lst06, (q) => q.neq('lan_kod', '06'))).toBe(0);
  });

  it('a kommun sees every shelter in its kommun and none outside it', async () => {
    expect(await visibleCount(as.kommun0580)).toBe(await adminCount('kommun_kod', '0580'));
    expect(await visibleCount(as.kommun0580, (q) => q.neq('kommun_kod', '0580'))).toBe(0);
    expect(await visibleCount(as.kommun0581, (q) => q.neq('kommun_kod', '0581'))).toBe(0);
  });

  it('users without an organisation, and anonymous callers, see no shelters at all', async () => {
    expect(await visibleCount(as.noOrg)).toBe(0);
    expect(await visibleCount(as.anon)).toBe(0);
  });

  it('nobody can change shelter data through the API', async () => {
    for (const caller of ALL_CALLERS) {
      await as[caller].from('shelters').update({ capacity: 9999 }).eq('id', fx.shelters.A1);
      await as[caller].from('shelters').delete().eq('id', fx.shelters.U1);
      const { error } = await as[caller].from('shelters').insert({
        id: `TEST-${fx.run}-X-${caller}`, kommun_kod: '0580', lon: 15.6, lat: 58.4,
      });
      expect(error, caller).not.toBeNull();
    }
    const { data } = await admin.from('shelters').select('id, capacity').in('id', [fx.shelters.A1, fx.shelters.U1]);
    expect(data).toHaveLength(2);
    expect(data!.every((s) => s.capacity === 50)).toBe(true);
  });
});

describe('shelter assignments', () => {
  const expected: Record<RoleKey | 'anon', string[]> = {
    ownerAdminA: ['A1', 'A2'],
    caretakerA: ['A1', 'A2'],
    ownerAdminB: ['B1'],
    lst05: ['A1', 'A2', 'B1'],
    lst06: [],
    kommun0580: [],
    kommun0581: [],
    noOrg: [],
    anon: [],
  };

  it.each(ALL_CALLERS)('%s sees only the assignments in its scope', async (caller) => {
    const data = await rows<{ shelter_id: string }>(
      as[caller].from('shelter_assignments').select('shelter_id').in('shelter_id', testShelterIds()),
    );
    expect(data.map((r) => shelterKey(r.shelter_id)).sort()).toEqual(expected[caller]);
  });

  it('nobody can claim, steal or release a shelter', async () => {
    for (const caller of ALL_CALLERS) {
      const claim = await as[caller].from('shelter_assignments').insert({ shelter_id: fx.shelters.U1, owner_org_id: fx.orgs.ownerA });
      expect(claim.error, `${caller} claim`).not.toBeNull();
      await as[caller].from('shelter_assignments').update({ owner_org_id: fx.orgs.ownerA }).eq('shelter_id', fx.shelters.B1);
      await as[caller].from('shelter_assignments').delete().eq('shelter_id', fx.shelters.A1);
    }
    const { data } = await admin.from('shelter_assignments').select('shelter_id, owner_org_id').in('shelter_id', testShelterIds());
    const owners = Object.fromEntries(data!.map((r) => [shelterKey(r.shelter_id), orgKey(r.owner_org_id)]));
    expect(owners).toEqual({ A1: 'ownerA', A2: 'ownerA', B1: 'ownerB' });
  });
});

describe('organisations', () => {
  const expected: Record<RoleKey | 'anon', string[]> = {
    ownerAdminA: ['ownerA'],
    caretakerA: ['ownerA'],
    ownerAdminB: ['ownerB'],
    lst05: ['lst05', 'ownerA', 'ownerB'],
    lst06: ['lst06'],
    kommun0580: ['kommun0580'],
    kommun0581: ['kommun0581'],
    noOrg: [],
    anon: [],
  };

  it.each(ALL_CALLERS)('%s sees only its own organisation (and a länsstyrelse its owners)', async (caller) => {
    const data = await rows<{ id: string }>(as[caller].from('organisations').select('id').in('id', Object.values(fx.orgs)));
    expect(data.map((r) => orgKey(r.id)).sort()).toEqual(expected[caller].sort());
  });

  it('nobody can create or rename an organisation', async () => {
    for (const caller of ALL_CALLERS) {
      const { error } = await as[caller].from('organisations').insert({ kind: 'owner', name: `Evil ${caller} ${fx.run}` });
      expect(error, caller).not.toBeNull();
      await as[caller].from('organisations').update({ name: 'Renamed' }).eq('id', fx.orgs.ownerA);
    }
    const { data } = await admin.from('organisations').select('name').eq('id', fx.orgs.ownerA).single();
    expect(data!.name).toBe(`Test Ägare A ${fx.run}`);
  });
});

describe('memberships', () => {
  const expected: Record<RoleKey | 'anon', RoleKey[]> = {
    ownerAdminA: ['caretakerA', 'ownerAdminA'],
    caretakerA: ['caretakerA', 'ownerAdminA'],
    ownerAdminB: ['ownerAdminB'],
    lst05: ['lst05'],
    lst06: ['lst06'],
    kommun0580: ['kommun0580'],
    kommun0581: ['kommun0581'],
    noOrg: [],
    anon: [],
  };

  it.each(ALL_CALLERS)('%s sees only memberships of its own organisations', async (caller) => {
    const data = await rows<{ user_id: string }>(
      as[caller].from('memberships').select('user_id').in('org_id', Object.values(fx.orgs)),
    );
    expect(data.map((r) => userKey(r.user_id)).sort()).toEqual(expected[caller]);
  });

  it('nobody can add themselves to another organisation or raise their own role', async () => {
    const attempts: [RoleKey, string, string][] = [
      ['caretakerA', 'lst05', 'inspector'],
      ['noOrg', 'ownerA', 'owner_admin'],
      ['kommun0580', 'lst05', 'lst_admin'],
      ['ownerAdminB', 'ownerA', 'owner_admin'],
    ];
    for (const [caller, org, role] of attempts) {
      const { error } = await as[caller].from('memberships').insert({
        user_id: fx.users[caller].id, org_id: fx.orgs[org as keyof Fixtures['orgs']], role,
      });
      expect(error, `${caller} -> ${org}`).not.toBeNull();
    }
    await as.caretakerA.from('memberships').update({ role: 'owner_admin' }).eq('user_id', fx.users.caretakerA.id);
    const { data } = await admin.from('memberships').select('role').eq('user_id', fx.users.caretakerA.id);
    expect(data).toEqual([{ role: 'caretaker' }]);
    const { count } = await admin.from('memberships').select('org_id', { count: 'exact', head: true }).eq('user_id', fx.users.noOrg.id);
    expect(count).toBe(0);
  });
});

describe('profiles (personal data)', () => {
  const expected: Record<RoleKey | 'anon', RoleKey[]> = {
    ownerAdminA: ['caretakerA', 'ownerAdminA'],
    caretakerA: ['caretakerA', 'ownerAdminA'],
    ownerAdminB: ['ownerAdminB'],
    lst05: ['lst05'],
    lst06: ['lst06'],
    kommun0580: ['kommun0580'],
    kommun0581: ['kommun0581'],
    noOrg: ['noOrg'],
    anon: [],
  };

  it.each(ALL_CALLERS)('%s sees only itself and its colleagues', async (caller) => {
    const ids = Object.values(fx.users).map((u) => u.id);
    const data = await rows<{ user_id: string }>(as[caller].from('profiles').select('user_id').in('user_id', ids));
    expect(data.map((r) => userKey(r.user_id)).sort()).toEqual(expected[caller]);
  });

  it('a user can edit their own profile but nobody else’s', async () => {
    const own = await as.ownerAdminA.from('profiles').update({ full_name: 'Edited by self' }).eq('user_id', fx.users.ownerAdminA.id).select();
    expect(own.error).toBeNull();
    expect(own.data).toHaveLength(1);

    await as.ownerAdminA.from('profiles').update({ full_name: 'Edited by boss' }).eq('user_id', fx.users.caretakerA.id);
    await as.lst05.from('profiles').update({ full_name: 'Edited by LST' }).eq('user_id', fx.users.ownerAdminB.id);
    const { data } = await admin.from('profiles').select('user_id, full_name').in('user_id', [fx.users.caretakerA.id, fx.users.ownerAdminB.id]);
    expect(data!.map((r) => r.full_name).sort()).toEqual(['Test caretakerA', 'Test ownerAdminB']);
  });
});

describe('audit log', () => {
  async function auditRows(caller: RoleKey | 'anon') {
    return rows<{ org_id: string | null; shelter_id: string | null; table_name: string; actor_role: string }>(
      as[caller].from('audit_log').select('org_id, shelter_id, table_name, actor_role')
        .or(`org_id.in.(${Object.values(fx.orgs).join(',')}),shelter_id.in.(${testShelterIds().join(',')})`),
    );
  }

  it('records assignments and memberships, attributed to the service role', async () => {
    const data = await rows<{ table_name: string; actor_role: string; actor_id: string | null }>(
      admin.from('audit_log').select('table_name, actor_role, actor_id').eq('shelter_id', fx.shelters.A1),
    );
    expect(data.some((r) => r.table_name === 'shelter_assignments' && r.actor_role === 'service_role' && r.actor_id === null)).toBe(true);
    const { count } = await admin.from('audit_log').select('id', { count: 'exact', head: true })
      .eq('table_name', 'memberships').eq('org_id', fx.orgs.ownerA);
    expect(count).toBe(2);
  });

  it('owner admins see only their own organisation’s history', async () => {
    const a = await auditRows('ownerAdminA');
    expect(a.length).toBeGreaterThan(0);
    expect(new Set(a.map((r) => orgKey(r.org_id ?? '')))).toEqual(new Set(['ownerA']));
    const b = await auditRows('ownerAdminB');
    expect(new Set(b.map((r) => orgKey(r.org_id ?? '')))).toEqual(new Set(['ownerB']));
  });

  it('a länsstyrelse sees the history of shelters in its län, and nothing about other län', async () => {
    const l05 = await auditRows('lst05');
    const shelters05 = new Set(l05.filter((r) => r.shelter_id).map((r) => shelterKey(r.shelter_id!)));
    expect(shelters05).toEqual(new Set(['A1', 'A2', 'B1']));
    expect(l05.some((r) => ['lst06', 'kommun0580', 'kommun0581'].includes(orgKey(r.org_id ?? '') ?? ''))).toBe(false);

    const l06 = await auditRows('lst06');
    expect(l06.filter((r) => r.shelter_id)).toEqual([]);
    expect(new Set(l06.map((r) => orgKey(r.org_id ?? '')))).toEqual(new Set(['lst06']));
  });

  it.each(['caretakerA', 'kommun0580', 'kommun0581', 'noOrg', 'anon'] as const)('%s sees no history', async (caller) => {
    expect(await auditRows(caller)).toEqual([]);
  });

  it('nobody can write to the audit log, and even the service role cannot rewrite it', async () => {
    for (const caller of ALL_CALLERS) {
      const { error } = await as[caller].from('audit_log').insert({
        actor_role: 'x', action: 'insert', table_name: 'fake', row_key: 'fake',
      });
      expect(error, caller).not.toBeNull();
    }
    const upd = await admin.from('audit_log').update({ table_name: 'tampered' }).eq('org_id', fx.orgs.ownerA);
    expect(upd.error?.message).toMatch(/append-only/);
    const del = await admin.from('audit_log').delete().eq('org_id', fx.orgs.ownerA);
    expect(del.error?.message).toMatch(/append-only/);
  });
});

describe('API surface', () => {
  it('internal helper functions cannot be called over HTTP', async () => {
    for (const fn of ['my_org_ids', 'my_owned_shelter_ids', 'is_shelter_owner']) {
      const { error } = await as.lst05.rpc(fn as never);
      expect(error, fn).not.toBeNull();
    }
  });

  it('reference data (län, kommuner) is readable when signed in, but not anonymously', async () => {
    expect((await rows(as.kommun0580.from('lan').select('kod'))).length).toBe(21);
    expect((await rows(as.noOrg.from('kommuner').select('kod').eq('lan_kod', '05'))).length).toBe(13);
    expect(await rows(as.anon.from('lan').select('kod'))).toEqual([]);
    expect(await rows(as.anon.from('kommuner').select('kod'))).toEqual([]);
  });
});
