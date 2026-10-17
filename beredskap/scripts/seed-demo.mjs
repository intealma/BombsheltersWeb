// Builds a realistic spread of statuses on top of the demo organisations
// from seed-users.mjs: open and overdue orders, submitted self-checks with
// photos, reviews (approved, deficiencies, site visits) and a year of
// maintenance history. Deterministic: every reset gives the same picture,
// with dates relative to today so "overdue" stays overdue.
//
//   npm run demo:reset
//
// Everything is fictional. The photos are drawn placeholders stamped DEMOBILD.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { ROOT, supabaseEnv } from './local-env.mjs';

const env = supabaseEnv();
const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) fail(`${what}: ${error.message}`);
  return data;
}

// --------------------------------------------------------------- randomness
// A small seeded generator, so the demo looks the same after every reset.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261017);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
// UUIDs from the seeded generator, so ids are stable between resets too.
function uuid() {
  const b = Array.from({ length: 16 }, () => Math.floor(rand() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------------- dates
const DAY = 86_400_000;
const now = Date.now();
const at = (daysAgo, hour = 10) => {
  const d = new Date(now - daysAgo * DAY);
  d.setUTCHours(hour - 2, between(0, 59), 0, 0); // roughly Swedish office hours
  return d.toISOString();
};
const dateOnly = (daysFromToday) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date(now + daysFromToday * DAY));

// --------------------------------------------------------------- the scene
// How many shelters of each owner end up in each state.
const SPREAD = {
  'Demo Fastigheter AB': { approved: 14, brister: 4, platsbesok: 2, submitted: 5, overdue: 6, ordered: 45 },
  'Demo Bostäder Norrköping AB': { approved: 16, brister: 5, platsbesok: 1, submitted: 4, overdue: 8, ordered: 50 },
  'Demo Fastighets AB Motala': { approved: 6, brister: 2, platsbesok: 1, submitted: 2, overdue: 3, ordered: 20 },
  'Demo BRF Exempelgården': { approved: 1, ordered: 1 },
};
const INSPECTORS = {
  'Demo Fastigheter AB': ['skotare@example.com', 'agare@example.com'],
  'Demo Bostäder Norrköping AB': ['norrkoping@example.com'],
  'Demo Fastighets AB Motala': ['motala@example.com'],
  'Demo BRF Exempelgården': ['brf@example.com'],
};
const PHOTO_ITEMS = ['dorr', 'ventilation', 'golvbrunn', 'atkomst', 'skylt'];
const BRIST_COMMENTS = {
  dorr: ['Gångjärnen rostiga, dörren går trögt.', 'Dörren går inte att regla helt.', 'Tätningslisten är sprucken.'],
  ventilation: ['Ett filter saknas i aggregatet.', 'Slangen till aggregatet har en spricka.', 'Aggregatet startar inte vid provkörning.'],
  golvbrunn: ['Avstängningen till golvbrunnen saknas.', 'Locket till golvbrunnen går inte att stänga.'],
  atkomst: ['Cyklar och förrådsfack blockerar vägen in.', 'Möbler står framför nödutgången.'],
  skylt: ['Skylten på fasaden saknas.', 'Skylten är skadad och svår att läsa.'],
};
const REVIEW_COMMENTS = {
  brist: ['Åtgärda och skicka in en ny kontroll inom 60 dagar.', 'Bristen ska åtgärdas före nästa kontroll.'],
  platsbesok: ['Vi bokar ett platsbesök för att bedöma åtgärden.', 'Platsbesök krävs innan vi kan godkänna.'],
};
const MAINTENANCE = [
  ['ventilation', 'Bytt grovfilter och finfilter i ventilationsaggregatet.', 'Demo Ventilation AB'],
  ['ventilation', 'Provkört ventilationsaggregatet, inga anmärkningar.', 'Demo Ventilation AB'],
  ['dorrar', 'Smort gångjärn och reglar på skyddsrumsdörren.', null],
  ['dorrar', 'Bytt tätningslist på skyddsrumsdörren.', 'Demo Lås & Dörr AB'],
  ['rensning', 'Tömt förrådsfack som blockerade vägen till nödutgången.', null],
  ['skyltning', 'Satt upp ny skyddsrumsskylt på fasaden.', 'Demo Skylt AB'],
  ['inspektion', 'Egen tillsyn av skyddsrummet enligt rutin.', null],
  ['utrustning', 'Inventerat utrustningsförrådet, allt finns på plats.', null],
  ['reparation', 'Lagat spricka i golvbrunnens lock.', 'Demo Bygg & Service AB'],
];

// ------------------------------------------------------------------ load
const orgs = await must(admin.from('organisations').select('id, name, kind').eq('is_demo', true), 'list demo organisations');
const lst = orgs.find((o) => o.kind === 'lansstyrelse');
if (!lst) fail('No demo länsstyrelse found. Run scripts/seed-users.mjs first.');

const usersByEmail = {};
for (let page = 1; ; page++) {
  const { users } = await must(admin.auth.admin.listUsers({ page, perPage: 1000 }), 'list users');
  for (const u of users) usersByEmail[u.email] = u.id;
  if (users.length < 1000) break;
}
const lstUser = usersByEmail['lansstyrelse@example.com'];
const names = Object.fromEntries((await must(admin.from('profiles').select('user_id, full_name'), 'list profiles')).map((p) => [p.user_id, p.full_name]));

const template = await must(
  admin.from('checklist_templates').select('id, checklist_items(id, key, position, title_sv, title_en)').eq('active', true).single(),
  'load checklist',
);
const items = [...template.checklist_items].sort((a, b) => a.position - b.position);

const photoBytes = Object.fromEntries(PHOTO_ITEMS.map((k) => [k, readFileSync(path.join(ROOT, 'scripts', 'demo-photos', `${k}.jpg`))]));

// ------------------------------------------------------------------ build
const notices = [];
const orders = [];
const checks = [];
const answers = [];
const photos = [];
const reviews = [];
const itemReviews = [];
const uploads = [];
const tally = { ordered: 0, overdue: 0, submitted: 0, approved: 0, brister: 0, platsbesok: 0 };

function addPhoto(shelterId, ownerOrgId, contextId, context, itemKey, userId, createdAt) {
  const id = uuid();
  const storagePath = `${shelterId}/${context}/${contextId}/${id}.jpg`;
  const bytes = photoBytes[itemKey] ?? photoBytes.dorr;
  uploads.push({ storagePath, bytes });
  photos.push({
    id, shelter_id: shelterId, owner_org_id: ownerOrgId, context, context_id: contextId,
    item_key: context === 'self_check' ? itemKey : null,
    storage_path: storagePath, bytes: bytes.length, width: 1200, height: 900, uploaded_by: userId, created_at: createdAt,
  });
}

for (const org of orgs.filter((o) => o.kind === 'owner')) {
  const spread = SPREAD[org.name];
  if (!spread) continue;
  const assigned = (await must(admin.from('shelter_assignments').select('shelter_id').eq('owner_org_id', org.id).order('shelter_id'), `assignments ${org.name}`)).map((a) => a.shelter_id);
  const pool = shuffle(assigned);
  const take = (n) => pool.splice(0, n ?? 0);
  const scene = {
    approved: take(spread.approved), brister: take(spread.brister), platsbesok: take(spread.platsbesok),
    submitted: take(spread.submitted), overdue: take(spread.overdue), ordered: take(spread.ordered),
  };

  // Two order batches: an older one (due a week ago) and a recent one.
  const early = { id: uuid(), token: randomBytes(18).toString('base64url'), issued: at(35, 9), due: dateOnly(-7) };
  const recent = { id: uuid(), token: randomBytes(18).toString('base64url'), issued: at(5, 9), due: dateOnly(25) };
  const answeredLater = [...scene.approved, ...scene.brister, ...scene.platsbesok, ...scene.submitted];
  const batchFor = { early: [...scene.overdue, ...answeredLater], recent: scene.ordered };
  for (const [batch, shelters] of [[early, batchFor.early], [recent, batchFor.recent]]) {
    if (!shelters.length) continue;
    notices.push({
      id: batch.id, token: batch.token, batch_id: batch.id, lst_org_id: lst.id, lst_name: lst.name,
      owner_org_id: org.id, due_date: batch.due, created_by: lstUser, created_at: batch.issued,
    });
    for (const shelterId of shelters) {
      orders.push({
        id: uuid(), notice_id: batch.id, shelter_id: shelterId, lst_org_id: lst.id, owner_org_id: org.id,
        due_date: batch.due, issued_by: lstUser, issued_at: batch.issued,
      });
    }
  }
  tally.ordered += scene.ordered.length;
  tally.overdue += scene.overdue.length;

  // Submitted self-checks, some reviewed.
  for (const [state, shelters] of Object.entries(scene)) {
    if (!['approved', 'brister', 'platsbesok', 'submitted'].includes(state)) continue;
    for (const shelterId of shelters) {
      const inspector = usersByEmail[pick(INSPECTORS[org.name])];
      const checkId = uuid();
      const submittedDaysAgo = state === 'submitted' ? between(1, 4) : between(9, 30);
      const submittedAt = at(submittedDaysAgo, between(8, 16));
      const bristKeys =
        state === 'brister' ? shuffle(PHOTO_ITEMS).slice(0, between(1, 2))
        : state === 'platsbesok' ? [pick(PHOTO_ITEMS)]
        : state === 'submitted' && rand() < 0.5 ? [pick(PHOTO_ITEMS)]
        : [];
      let ok = 0, brist = 0, na = 0;
      for (const item of items) {
        const status = bristKeys.includes(item.key) ? 'brist' : item.key === 'golvbrunn' && rand() < 0.12 ? 'ej_tillampligt' : 'ok';
        if (status === 'ok') ok++; else if (status === 'brist') brist++; else na++;
        answers.push({
          self_check_id: checkId, item_id: item.id, position: item.position, item_key: item.key,
          item_title_sv: item.title_sv, item_title_en: item.title_en, status,
          comment: status === 'brist' ? pick(BRIST_COMMENTS[item.key]) : '',
        });
        if (status === 'brist') addPhoto(shelterId, org.id, checkId, 'self_check', item.key, inspector, submittedAt);
      }
      checks.push({
        id: checkId, shelter_id: shelterId, owner_org_id: org.id, template_id: template.id,
        inspector_name: names[inspector] ?? 'Demo', submitted_by: inspector, started_at: submittedAt, submitted_at: submittedAt,
        ok_count: ok, brist_count: brist, na_count: na,
      });

      if (state === 'submitted') {
        tally.submitted++;
        continue;
      }
      const reviewId = uuid();
      const reviewedAt = at(Math.max(0, submittedDaysAgo - between(1, 6)), between(9, 15));
      const visitKey = state === 'platsbesok' ? bristKeys[0] : null;
      reviews.push({
        id: reviewId, self_check_id: checkId, shelter_id: shelterId, lst_org_id: lst.id, owner_org_id: org.id,
        outcome: state === 'approved' ? 'godkand' : state === 'brister' ? 'brister' : 'platsbesok',
        comment: state === 'approved' ? '' : pick(state === 'brister' ? REVIEW_COMMENTS.brist : REVIEW_COMMENTS.platsbesok),
        reviewed_by: lstUser, reviewed_at: reviewedAt,
      });
      for (const item of items) {
        const decision = item.key === visitKey ? 'platsbesok' : bristKeys.includes(item.key) ? 'brist' : 'godkand';
        itemReviews.push({
          review_id: reviewId, item_id: item.id, decision,
          comment: decision === 'godkand' ? '' : pick(decision === 'brist' ? REVIEW_COMMENTS.brist : REVIEW_COMMENTS.platsbesok),
        });
      }
      tally[state]++;
    }
  }
}

// A year of maintenance for some of Demo Fastigheter AB's shelters.
const owner = orgs.find((o) => o.name === 'Demo Fastigheter AB');
const ownerShelters = (await must(admin.from('shelter_assignments').select('shelter_id').eq('owner_org_id', owner.id).order('shelter_id'), 'owner shelters')).map((a) => a.shelter_id);
const maintenance = [];
const voids = [];
for (const shelterId of shuffle(ownerShelters).slice(0, 30)) {
  for (let n = between(1, 4); n > 0; n--) {
    const [category, description, firm] = pick(MAINTENANCE);
    const registrar = usersByEmail[pick(INSPECTORS['Demo Fastigheter AB'])];
    const performedDaysAgo = between(3, 400);
    const performedOn = dateOnly(-performedDaysAgo);
    const id = uuid();
    maintenance.push({
      id, shelter_id: shelterId, owner_org_id: owner.id, performed_on: performedOn, category, description,
      performed_by: firm ?? names[registrar] ?? 'Demo', registered_by: registrar,
      created_at: at(performedDaysAgo - (rand() < 0.8 ? 0 : between(1, 3)), between(13, 18)),
    });
    if (rand() < 0.08) addPhoto(shelterId, owner.id, id, 'maintenance', category === 'ventilation' ? 'ventilation' : 'dorr', registrar, maintenance.at(-1).created_at);
  }
}
// One voided entry, to show how mistakes are handled.
const wrong = maintenance[0];
voids.push({
  entry_id: wrong.id, shelter_id: wrong.shelter_id, owner_org_id: owner.id,
  reason: 'Registrerad på fel skyddsrum.', voided_by: usersByEmail['agare@example.com'],
  voided_at: new Date(new Date(wrong.created_at).getTime() + DAY).toISOString(),
});

// ------------------------------------------------------------------ write
async function insertAll(table, rows) {
  for (let i = 0; i < rows.length; i += 500) await must(admin.from(table).insert(rows.slice(i, i + 500)), `insert ${table}`);
}

for (const u of uploads) {
  const { error } = await admin.storage.from('photos').upload(u.storagePath, u.bytes, { contentType: 'image/jpeg', upsert: true });
  if (error) fail(`upload ${u.storagePath}: ${error.message}`);
}
await insertAll('order_notices', notices);
await insertAll('orders', orders);
// Inserting a self-check answers the open order for that shelter (trigger).
await insertAll('self_checks', checks);
await insertAll('self_check_answers', answers);
await insertAll('photos', photos);
await insertAll('self_check_reviews', reviews);
await insertAll('self_check_item_reviews', itemReviews);
await insertAll('maintenance_entries', maintenance);
await insertAll('maintenance_voids', voids);

console.log(
  `Demo scene ready: ${tally.ordered} ordered, ${tally.overdue} overdue, ${tally.submitted} awaiting review, ` +
    `${tally.approved} approved, ${tally.brister} with deficiencies, ${tally.platsbesok} site visits; ` +
    `${photos.length} photos, ${maintenance.length} maintenance entries.`,
);
