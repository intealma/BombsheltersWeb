// Receives one JPEG from a signed-in owner or caretaker, strips its metadata
// (EXIF/GPS and the rest), asks the database whether the caller may add a
// photo for that shelter, and stores the clean file in the private bucket.
//
// POST /functions/v1/upload-photo?photo_id=&shelter_id=&context=&context_id=&item_key=
//   Authorization: Bearer <user access token>
//   Content-Type: image/jpeg
//   body: the image bytes (max 5 MB)

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { InvalidJpeg, stripJpegMetadata } from '../_shared/jpeg.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SIDE = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHELTER_ID = /^[0-9A-Za-z-]{1,32}$/;
const ITEM_KEY = /^[a-z0-9_-]{0,40}$/;
const CONTEXTS = new Set(['self_check', 'maintenance']);

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function reply(req: Request, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function env(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  throw new Error(`missing environment variable ${names[0]}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'method not allowed' });

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return reply(req, 401, { error: 'not signed in' });

  const q = new URL(req.url).searchParams;
  const photoId = q.get('photo_id') ?? '';
  const shelterId = q.get('shelter_id') ?? '';
  const context = q.get('context') ?? '';
  const contextId = q.get('context_id') ?? '';
  const itemKey = q.get('item_key') ?? '';
  if (!UUID.test(photoId) || !UUID.test(contextId) || !SHELTER_ID.test(shelterId) || !CONTEXTS.has(context) || !ITEM_KEY.test(itemKey)) {
    return reply(req, 400, { error: 'invalid parameters' });
  }

  if (Number(req.headers.get('Content-Length') ?? '0') > MAX_BYTES) return reply(req, 413, { error: 'image too large' });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) return reply(req, 400, { error: 'empty body' });
  if (body.length > MAX_BYTES) return reply(req, 413, { error: 'image too large' });

  let clean;
  try {
    clean = stripJpegMetadata(body);
  } catch (e) {
    if (e instanceof InvalidJpeg) return reply(req, 415, { error: 'only JPEG images are accepted' });
    throw e;
  }
  if (clean.width > MAX_SIDE || clean.height > MAX_SIDE) return reply(req, 400, { error: 'image dimensions too large' });

  const url = env('SUPABASE_URL');

  // The permission check runs as the caller, in the database.
  const asUser = createClient(url, env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: path, error } = await asUser.rpc('register_photo', {
    p_id: photoId,
    p_shelter_id: shelterId,
    p_context: context,
    p_context_id: contextId,
    p_item_key: itemKey,
    p_bytes: clean.bytes.length,
    p_width: clean.width,
    p_height: clean.height,
  });
  if (error) {
    const status = error.code === '42501' ? 403 : error.code === '28000' ? 401 : error.code === 'PT429' ? 429 : 400;
    return reply(req, status, { error: error.message });
  }

  // Only now, with permission granted, store the clean bytes.
  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const upload = await admin.storage.from('photos').upload(path as string, clean.bytes, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (upload.error && !/exists|duplicate/i.test(upload.error.message)) {
    console.error('storage upload failed', upload.error.message);
    return reply(req, 502, { error: 'could not store the image, try again' });
  }

  return reply(req, 201, { id: photoId, path, width: clean.width, height: clean.height, bytes: clean.bytes.length });
});
