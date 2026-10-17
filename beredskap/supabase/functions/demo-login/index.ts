// Demo only. Signs a visitor in as one of the four fictional demo users after
// they enter the access code you share in the meeting. The demo password
// never reaches the browser; the access code keeps the fictional statuses
// (shown on real addresses) away from anyone who just finds the URL.
//
// Disabled unless DEMO_MODE=true. Never set that on a production project.
//
// POST /functions/v1/demo-login  { "role": "owner" | "caretaker" | "lansstyrelse" | "kommun", "code": "…" }
//   → { access_token, refresh_token, expires_at }

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const DEMO_USERS: Record<string, string> = {
  owner: 'agare@example.com',
  caretaker: 'skotare@example.com',
  lansstyrelse: 'lansstyrelse@example.com',
  kommun: 'kommun@example.com',
};

const MAX_FAILURES = 10;
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map<string, { count: number; until: number }>();

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function reply(req: Request, status: number, body: Record<string, unknown>): Response {
  const origin = req.headers.get('Origin') ?? '';
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      Vary: 'Origin',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Compares in constant time, so the response time does not leak the code. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return reply(req, 204, {});
  if (Deno.env.get('DEMO_MODE') !== 'true') return reply(req, 404, { error: 'not found' });
  if (req.method !== 'POST') return reply(req, 405, { error: 'method not allowed' });

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const record = failures.get(ip);
  if (record && record.until > Date.now() && record.count >= MAX_FAILURES) {
    return reply(req, 429, { error: 'too many attempts, try again later' });
  }

  const body = await req.json().catch(() => null);
  const role = typeof body?.role === 'string' ? body.role : '';
  const code = typeof body?.code === 'string' ? body.code.slice(0, 200) : '';
  if (!DEMO_USERS[role]) return reply(req, 400, { error: 'unknown role' });

  const expected = Deno.env.get('DEMO_ACCESS_CODE') ?? '';
  const password = Deno.env.get('DEMO_PASSWORD') ?? '';
  if (expected.length < 8 || !password) return reply(req, 503, { error: 'demo is not configured' });

  if (!sameBytes(await sha256(code), await sha256(expected))) {
    const current = record && record.until > Date.now() ? record : { count: 0, until: Date.now() + WINDOW_MS };
    failures.set(ip, { count: current.count + 1, until: current.until });
    return reply(req, 401, { error: 'wrong access code' });
  }
  failures.delete(ip);

  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email: DEMO_USERS[role], password });
  if (error || !data.session) {
    console.error('demo sign-in failed', error?.message);
    return reply(req, 502, { error: 'demo sign-in failed; has the demo been seeded?' });
  }

  return reply(req, 200, {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
});
