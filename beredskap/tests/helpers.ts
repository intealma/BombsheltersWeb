import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseEnv } from '../scripts/local-env.mjs';

export const env = supabaseEnv();

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}. Is the local Supabase stack running (npm run db:start)?`);
  return value;
}
const url = required(env.url, 'Supabase URL');
const anonKey = required(env.anonKey, 'anon key');
const serviceKey = required(env.serviceKey, 'service role key');

// These tests create and delete organisations, users and shelters with the
// service role. Never point them at the demo or a production project by
// accident.
if (!env.isLocal && process.env.ALLOW_REMOTE_TESTS !== '1') {
  throw new Error(`Refusing to run tests against ${env.url}. Set ALLOW_REMOTE_TESTS=1 if you really mean it.`);
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

export const admin = createClient(url, serviceKey, clientOptions);

export function anonClient(): SupabaseClient {
  return createClient(url, anonKey, clientOptions);
}

export async function signedIn(email: string, password: string): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return client;
}

async function must<R extends { data: unknown; error: { message: string } | null }>(
  promise: PromiseLike<R>,
  what: string,
): Promise<NonNullable<R['data']>> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as NonNullable<R['data']>;
}

export const ROLES = [
  'ownerAdminA',
  'caretakerA',
  'ownerAdminB',
  'lst05',
  'lst06',
  'kommun0580',
  'kommun0581',
  'noOrg',
] as const;
export type RoleKey = (typeof ROLES)[number];

export type Fixtures = Awaited<ReturnType<typeof createFixtures>>;

/**
 * A small world with two owners, two länsstyrelser (Östergötland, Jönköping)
 * and two kommuner (Linköping, Norrköping), each with one user per role, plus
 * five test shelters:
 *
 *   A1, A2  Linköping   owned by owner A
 *   U1      Linköping   unassigned
 *   B1      Norrköping  owned by owner B
 *   J1      Jönköping   unassigned (other län)
 */
export async function createFixtures() {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = `Test-${randomUUID()}-Aa1`;

  const orgDefs = {
    ownerA: { kind: 'owner', name: `Test Ägare A ${run}` },
    ownerB: { kind: 'owner', name: `Test Ägare B ${run}` },
    lst05: { kind: 'lansstyrelse', name: `Test LST 05 ${run}`, lan_kod: '05' },
    lst06: { kind: 'lansstyrelse', name: `Test LST 06 ${run}`, lan_kod: '06' },
    kommun0580: { kind: 'kommun', name: `Test Kommun 0580 ${run}`, kommun_kod: '0580' },
    kommun0581: { kind: 'kommun', name: `Test Kommun 0581 ${run}`, kommun_kod: '0581' },
  } as const;
  type OrgKey = keyof typeof orgDefs;

  const orgRows = await must(
    admin.from('organisations').insert(Object.values(orgDefs)).select('id, name'),
    'create organisations',
  );
  const orgs = Object.fromEntries(
    (Object.keys(orgDefs) as OrgKey[]).map((k) => [k, orgRows.find((r) => r.name === orgDefs[k].name)!.id]),
  ) as Record<OrgKey, string>;

  const shelterDefs = {
    A1: { kommun_kod: '0580', lon: 15.62, lat: 58.41 },
    A2: { kommun_kod: '0580', lon: 15.63, lat: 58.42 },
    U1: { kommun_kod: '0580', lon: 15.64, lat: 58.4 },
    B1: { kommun_kod: '0581', lon: 16.18, lat: 58.59 },
    J1: { kommun_kod: '0680', lon: 14.16, lat: 57.78 },
  } as const;
  type ShelterKey = keyof typeof shelterDefs;
  const shelters = Object.fromEntries(
    (Object.keys(shelterDefs) as ShelterKey[]).map((k) => [k, `TEST-${run}-${k}`]),
  ) as Record<ShelterKey, string>;

  await must(
    admin.from('shelters').insert(
      (Object.keys(shelterDefs) as ShelterKey[]).map((k) => ({
        id: shelters[k],
        address: `Testgatan ${k}`,
        capacity: 50,
        ...shelterDefs[k],
      })),
    ),
    'create shelters',
  );

  await must(
    admin.from('shelter_assignments').insert([
      { shelter_id: shelters.A1, owner_org_id: orgs.ownerA },
      { shelter_id: shelters.A2, owner_org_id: orgs.ownerA },
      { shelter_id: shelters.B1, owner_org_id: orgs.ownerB },
    ]),
    'assign shelters',
  );

  const userDefs: Record<RoleKey, { org?: OrgKey; role?: string }> = {
    ownerAdminA: { org: 'ownerA', role: 'owner_admin' },
    caretakerA: { org: 'ownerA', role: 'caretaker' },
    ownerAdminB: { org: 'ownerB', role: 'owner_admin' },
    lst05: { org: 'lst05', role: 'inspector' },
    lst06: { org: 'lst06', role: 'inspector' },
    kommun0580: { org: 'kommun0580', role: 'kommun_viewer' },
    kommun0581: { org: 'kommun0581', role: 'kommun_viewer' },
    noOrg: {},
  };

  const users = {} as Record<RoleKey, { id: string; email: string }>;
  for (const key of ROLES) {
    const email = `${key.toLowerCase()}+${run}@example.org`;
    const { user } = await must(
      admin.auth.admin.createUser({ email, password, email_confirm: true }),
      `create user ${key}`,
    );
    users[key] = { id: user!.id, email };
    await must(admin.from('profiles').insert({ user_id: user!.id, full_name: `Test ${key}` }), `profile ${key}`);
    const def = userDefs[key];
    if (def.org) {
      await must(
        admin.from('memberships').insert({ user_id: user!.id, org_id: orgs[def.org], role: def.role }),
        `membership ${key}`,
      );
    }
  }

  async function cleanup() {
    for (const u of Object.values(users)) await admin.auth.admin.deleteUser(u.id);
    await admin.from('organisations').delete().in('id', Object.values(orgs));
    await admin.from('shelters').delete().in('id', Object.values(shelters));
  }

  return { run, password, orgs, shelters, users, cleanup };
}
