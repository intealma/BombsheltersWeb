// Creates the fictional demo organisations, their users, shelter
// assignments and 48-hour plans. Safe to re-run: existing demo data
// (including demo photo files) is removed first. seed-demo.mjs then adds
// orders, self-checks, reviews and maintenance on top.
//
//   npm run demo:reset          (this, then seed-demo.mjs)
//   npm run db:reset            (wipes the database, then demo:reset)
//
// The password for every demo user comes from DEMO_PASSWORD in .env.
// Every name here is fictional. Do not add real companies or people.

import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseEnv } from './local-env.mjs';

const ORGS = [
  { key: 'owner', kind: 'owner', name: 'Demo Fastigheter AB' },
  { key: 'brf', kind: 'owner', name: 'Demo BRF Exempelgården' },
  { key: 'norrkoping', kind: 'owner', name: 'Demo Bostäder Norrköping AB' },
  { key: 'motala', kind: 'owner', name: 'Demo Fastighets AB Motala' },
  { key: 'lst', kind: 'lansstyrelse', name: 'Demo Länsstyrelse Östergötland', lan_kod: '05' },
  { key: 'kommun', kind: 'kommun', name: 'Demo Kommun Linköping', kommun_kod: '0580' },
];

const USERS = [
  { email: 'agare@example.com', name: 'Anna Ägare (demo)', org: 'owner', role: 'owner_admin' },
  { email: 'skotare@example.com', name: 'Sam Skötare (demo)', org: 'owner', role: 'caretaker' },
  { email: 'brf@example.com', name: 'Bo Brf (demo)', org: 'brf', role: 'owner_admin' },
  { email: 'norrkoping@example.com', name: 'Nils Norrköping (demo)', org: 'norrkoping', role: 'owner_admin' },
  { email: 'motala@example.com', name: 'Mia Motala (demo)', org: 'motala', role: 'owner_admin' },
  { email: 'lansstyrelse@example.com', name: 'Lina Länsstyrelse (demo)', org: 'lst', role: 'lst_admin' },
  { email: 'kommun@example.com', name: 'Kim Kommun (demo)', org: 'kommun', role: 'kommun_viewer' },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
  fail('Set DEMO_PASSWORD in beredskap/.env: at least 12 characters with lower case, upper case and digits.');
}

const env = supabaseEnv();
const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) fail(`${what}: ${error.message}`);
  return data;
}

// 1. Remove previous demo data. Deleting the organisations cascades to
//    everything that belongs to them; photo files are removed explicitly.
const oldDemoOrgs = (await must(admin.from('organisations').select('id').eq('is_demo', true), 'list demo organisations')).map((o) => o.id);
if (oldDemoOrgs.length) {
  const paths = (await must(admin.from('photos').select('storage_path').in('owner_org_id', oldDemoOrgs).limit(10000), 'list demo photos')).map((p) => p.storage_path);
  for (let i = 0; i < paths.length; i += 100) await admin.storage.from('photos').remove(paths.slice(i, i + 100));
}
const demoEmails = new Set(USERS.map((u) => u.email));
for (let page = 1; ; page++) {
  const { users } = await must(admin.auth.admin.listUsers({ page, perPage: 1000 }), 'list users');
  for (const u of users) {
    if (demoEmails.has(u.email)) await must(admin.auth.admin.deleteUser(u.id), `delete ${u.email}`);
  }
  if (users.length < 1000) break;
}
await must(admin.from('organisations').delete().eq('is_demo', true), 'delete demo organisations');

// 2. Organisations.
const orgRows = await must(
  admin
    .from('organisations')
    .insert(ORGS.map(({ key, ...o }) => ({ ...o, is_demo: true })))
    .select('id, name'),
  'create organisations',
);
const orgId = Object.fromEntries(ORGS.map((o) => [o.key, orgRows.find((r) => r.name === o.name).id]));

// 3. Users, profiles and memberships.
for (const u of USERS) {
  const { user } = await must(
    admin.auth.admin.createUser({ email: u.email, password, email_confirm: true }),
    `create ${u.email}`,
  );
  await must(admin.from('profiles').insert({ user_id: user.id, full_name: u.name }), `profile ${u.email}`);
  await must(admin.from('memberships').insert({ user_id: user.id, org_id: orgId[u.org], role: u.role }), `membership ${u.email}`);
}

// 4. Shelter assignments, deterministic so every reset gives the same demo:
//    Demo Fastigheter AB gets every 8th Linköping shelter and the BRF three of
//    the ones in between; the Norrköping and Motala companies get every 8th
//    and every 5th shelter in their kommun.
async function sheltersIn(kommunKod) {
  // The API returns at most 1000 rows per request, so page through.
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await must(
      admin.from('shelters').select('id').eq('kommun_kod', kommunKod).order('id').range(from, from + 999),
      `list shelters in ${kommunKod}`,
    );
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
const linkoping = await sheltersIn('0580');
if (linkoping.length === 0) fail('No Linköping shelters found. Did the seed in supabase/seed/ run?');

const ownerShelters = linkoping.filter((_, i) => i % 8 === 0).map((s) => s.id);
const brfShelters = linkoping.filter((_, i) => i % 8 === 4).slice(0, 3).map((s) => s.id);
const norrkopingShelters = (await sheltersIn('0581')).filter((_, i) => i % 8 === 0).map((s) => s.id);
const motalaShelters = (await sheltersIn('0583')).filter((_, i) => i % 5 === 0).map((s) => s.id);
const assignments = [
  ...ownerShelters.map((id) => ({ shelter_id: id, owner_org_id: orgId.owner })),
  ...brfShelters.map((id) => ({ shelter_id: id, owner_org_id: orgId.brf })),
  ...norrkopingShelters.map((id) => ({ shelter_id: id, owner_org_id: orgId.norrkoping })),
  ...motalaShelters.map((id) => ({ shelter_id: id, owner_org_id: orgId.motala })),
];
for (let i = 0; i < assignments.length; i += 500) {
  await must(admin.from('shelter_assignments').insert(assignments.slice(i, i + 500)), 'assign shelters');
}

// 5. 48-hour plans: fictional contact people, a plan for every demo shelter
//    and someone responsible plus a backup for each task. The phone numbers
//    are from the series PTS reserves for fiction (070-174 06 05 to 06 99),
//    so they can never ring a real person.
const CONTACTS = {
  owner: [
    { key: 'karin', name: 'Karin Kontakt (demo)', phone: '070-174 06 05', email: 'karin@example.com', role_note: 'Driftansvarig' },
    { key: 'olle', name: 'Olle Ersättare (demo)', phone: '070-174 06 06', email: 'olle@example.com', role_note: 'Fastighetsskötare' },
    { key: 'maja', name: 'Maja Montör (demo)', phone: '070-174 06 07', email: null, role_note: 'Fastighetsskötare' },
    { key: 'erik', name: 'Erik Info (demo)', phone: '070-174 06 08', email: 'erik@example.com', role_note: 'Kommunikation' },
  ],
  brf: [
    { key: 'britt', name: 'Britt Ordförande (demo)', phone: '070-174 06 09', email: 'britt@example.com', role_note: 'Styrelseordförande' },
    { key: 'bengt', name: 'Bengt Styrelse (demo)', phone: '070-174 06 10', email: null, role_note: 'Styrelseledamot' },
  ],
};
// Who is responsible / backup for each template task, per organisation.
const ASSIGNMENTS = {
  owner: { informera: ['erik', 'karin'], tomma: ['olle', 'maja'], utrustning: ['maja', 'olle'], ventilation: ['karin', 'olle'], skyltning: ['olle', 'erik'] },
  brf: { informera: ['britt', 'bengt'], tomma: ['bengt', 'britt'], utrustning: ['bengt', 'britt'], ventilation: ['britt', 'bengt'], skyltning: ['bengt', 'britt'] },
};

const contactId = {};
for (const [org, people] of Object.entries(CONTACTS)) {
  const rows = people.map(({ key, ...c }) => {
    contactId[key] = randomUUID();
    return { id: contactId[key], owner_org_id: orgId[org], ...c };
  });
  await must(admin.from('org_contacts').insert(rows), `contacts ${org}`);
}

const templates = await must(
  admin.from('readiness_task_templates').select('id, key, position, title_sv, title_en, target_hour').eq('active', true).order('position'),
  'list task templates',
);
const taskRows = [];
for (const [org, shelters] of [['owner', ownerShelters], ['brf', brfShelters]]) {
  for (const shelterId of shelters) {
    for (const tp of templates) {
      const [responsible, backup] = ASSIGNMENTS[org][tp.key] ?? [];
      taskRows.push({
        shelter_id: shelterId,
        owner_org_id: orgId[org],
        template_id: tp.id,
        position: tp.position,
        title_sv: tp.title_sv,
        title_en: tp.title_en,
        target_hour: tp.target_hour,
        responsible_contact_id: responsible ? contactId[responsible] : null,
        backup_contact_id: backup ? contactId[backup] : null,
      });
    }
  }
}
for (let i = 0; i < taskRows.length; i += 500) {
  await must(admin.from('readiness_tasks').insert(taskRows.slice(i, i + 500)), 'create readiness tasks');
}

console.log(`Demo organisations ready: ${ORGS.length} organisations, ${USERS.length} users, ` +
  `${assignments.length} assigned shelters, ${taskRows.length} plan tasks.`);
console.log('Users (password = DEMO_PASSWORD in .env):');
for (const u of USERS) console.log(`  ${u.email.padEnd(26)} ${u.role}`);
