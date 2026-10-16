// Resolves Supabase connection settings for scripts and tests.
//
// Order: real environment variables, then beredskap/.env, then the running
// local stack (`npx supabase status`). The service role key is only ever read
// here, in Node; it must never get a VITE_ prefix, or Vite would ship it to
// the browser.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

let cachedStatus;
function localStatus() {
  if (!cachedStatus) {
    try {
      const out = execSync('npx supabase status -o json', {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      cachedStatus = JSON.parse(out.slice(out.indexOf('{')));
    } catch (e) {
      throw new Error(
        'Could not read the local Supabase stack. Is Docker Desktop running, and did you run "npm run db:start"?\n' +
          String(e.stderr || e.message),
      );
    }
  }
  return cachedStatus;
}

export function supabaseEnv() {
  let url = process.env.SUPABASE_URL;
  let anonKey = process.env.SUPABASE_ANON_KEY;
  let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let dbUrl = process.env.DATABASE_URL;

  if (!url || !anonKey || !serviceKey) {
    const s = localStatus();
    url ||= s.API_URL;
    anonKey ||= s.ANON_KEY || s.PUBLISHABLE_KEY;
    serviceKey ||= s.SERVICE_ROLE_KEY || s.SECRET_KEY;
    dbUrl ||= s.DB_URL;
  }

  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url || '');
  return { url, anonKey, serviceKey, dbUrl, isLocal };
}
