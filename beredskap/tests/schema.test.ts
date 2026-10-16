// Structural guarantees checked straight in Postgres, so a future migration
// cannot quietly add a table without RLS or hand privileges to `anon`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { env } from './helpers';

let db: pg.Client;

beforeAll(async () => {
  db = new pg.Client({ connectionString: env.dbUrl });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
});

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query(sql)).rows as T[];
}

describe('database guarantees', () => {
  it('every table in the public schema has row-level security enabled', async () => {
    const missing = await q(`
      select c.relname from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity`);
    expect(missing).toEqual([]);
  });

  it('anon has no privileges on any table, view or sequence in public', async () => {
    const grants = await q(`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'anon' and table_schema = 'public'`);
    expect(grants).toEqual([]);
    const seq = await q(`
      select c.relname from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') else false end`);
    expect(seq).toEqual([]);
  });

  it('signed-in users can only write to the tables this milestone allows', async () => {
    const writes = await q<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'authenticated' and table_schema = 'public'
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      order by 1, 2`);
    expect(writes).toEqual([{ table_name: 'profiles', privilege_type: 'INSERT' }]);
  });

  it('views in public run with the caller’s permissions (security_invoker)', async () => {
    const unsafe = await q(`
      select c.relname from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
        and not coalesce('security_invoker=true' = any (c.reloptions), false)`);
    expect(unsafe).toEqual([]);
  });

  it('no SECURITY DEFINER function is exposed in the public schema', async () => {
    const fns = await q(`select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef`);
    expect(fns).toEqual([]);
  });

  it('every SECURITY DEFINER function pins its search_path', async () => {
    const fns = await q(`
      select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')`);
    expect(fns).toEqual([]);
  });

  it('anon cannot execute any function in public', async () => {
    const fns = await q(`
      select p.proname from pg_proc p
      where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'EXECUTE')`);
    expect(fns).toEqual([]);
  });

  it('the photos bucket is private and only readable through policies', async () => {
    const [bucket] = await q<{ public: boolean }>(`select public from storage.buckets where id = 'photos'`);
    expect(bucket.public).toBe(false);
    const writes = await q(`
      select policyname, cmd from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and cmd <> 'SELECT'`);
    expect(writes).toEqual([]);
  });

  it('anon cannot use the private schema', async () => {
    const [{ ok }] = await q<{ ok: boolean }>(`select has_schema_privilege('anon', 'private', 'USAGE') as ok`);
    expect(ok).toBe(false);
  });

  it('the Östergötland seed is loaded: 13 kommuner, every shelter with a valid point', async () => {
    const [{ kommuner }] = await q<{ kommuner: number }>(`select count(*)::int as kommuner from public.kommuner where lan_kod = '05'`);
    expect(kommuner).toBe(13);
    const [{ shelters, bad }] = await q<{ shelters: number; bad: number }>(`
      select count(*)::int as shelters,
             count(*) filter (where extensions.st_y(geom::extensions.geometry) <> lat
                                 or extensions.st_x(geom::extensions.geometry) <> lon)::int as bad
      from public.shelters where lan_kod = '05' and id not like 'TEST-%'`);
    expect(shelters).toBe(3049);
    expect(bad).toBe(0);
  });
});
