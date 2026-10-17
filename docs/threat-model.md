# Threat model: Beredskap

Status: draft for Phase 1 (demo MVP), October 2026. Updated after milestone 7 (demo) and the public map's occupancy fix (T28–T29). Review at every milestone.

Beredskap is the login-gated part of skyddsrum.se. Property owners run self-checks
(*förenklad kontroll*), keep maintenance logs and 48-hour plans. Länsstyrelser issue
orders and review results. Kommuner see aggregate readiness. The public map is a
separate, unauthenticated page and is out of scope here, except for its check-ins
(T28–T29, and the Android notes below).

## Assets

| Asset | Why it matters | Sensitivity |
|---|---|---|
| Inspection results and deficiencies (*brister*) | Show where civil protection is weak. In wartime this is targeting information. | High |
| Photos from shelters | Show layout, doors, ventilation and weaknesses. Phone photos can carry GPS coordinates. | High |
| Orders and their status | Reveal which shelters the authority considers a problem. | Medium–High |
| 48h readiness plans | Name responsible people and their phone numbers, and describe how a shelter is activated. | Medium (personal data) |
| Maintenance logs | Evidence in compensation claims; tampering has a financial motive. | Medium (integrity) |
| Accounts and memberships | Decide who sees what. Escalation means a full data breach. | High |
| Audit log | Proof of who did what. Must not be editable. | High (integrity) |
| Shelter list (address, capacity, location) | Already public via MCF's open data. | Low |

## Actors

- **Legitimate users**: owner admins, caretakers, länsstyrelse inspectors and admins, kommun viewers.
- **Curious or careless insider**: a user who tries to see another organisation's data, or shares a screenshot.
- **Opportunistic attacker**: credential stuffing, scraping, exploiting a public endpoint.
- **Owner with a financial motive**: wants to backdate maintenance or hide a deficiency.
- **Hostile state actor**: wants a map of weak shelters. Patient and capable.
- **Platform operator** (us, the hosting provider): can see data at rest.

## Main threats and mitigations

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | A user reads another organisation's data by changing a request (IDOR). | Row-level security on every table, decided from memberships in the database. Automated tests sign in as each role and try. | **Done** (milestone 1), tests in `beredskap/tests/access.test.ts` |
| T2 | An owner claims shelters they do not own. | No insert/update/delete policy on assignments; only the service role (admin/seed) assigns. Tested. | **Done** |
| T3 | Privilege escalation: a user adds themselves to an organisation or raises their role. | Memberships are read-only through the API; a trigger checks that each role matches the organisation type. Tested. | **Done** |
| T4 | Anonymous or self-registered accounts get in. | Anonymous sign-in and self sign-up are disabled; anonymous JWTs are also ignored by the access helpers. A separate Supabase project from the public map, which does allow anonymous sign-in. | **Done** |
| T5 | A new table is added without RLS, or with grants to `anon`. | Default privileges revoked; schema tests fail if any public table lacks RLS, if `anon` has any grant, or if a security-definer function lacks a fixed `search_path`. | **Done** |
| T6 | Sensitive data leaks through public endpoints, the public GeoJSON or the JS bundle. | The public GeoJSON is checked for its four allowed properties; the build refuses secret keys in `VITE_*`; a test scans the bundle for secret keys. | **Done** |
| T7 | Tampering with history (backdated maintenance, deleted findings). | Append-only audit log written by triggers; updates and deletes are rejected even for the service role. Server-side timestamps. Submitted self-checks, their answers and photo records cannot be updated by anyone, including the service role. Maintenance entries are append-only: a mistake is voided with a reason by an owner admin and stays visible; the work date and the server registration time are both shown and exported, so backdating is visible. | **Done** (milestones 1–3) |
| T8 | Photo leaks: public bucket URLs, GPS coordinates in EXIF. | Private bucket; signed URLs valid 5 minutes, issued only to the owner organisation and the länsstyrelse; no storage write policies, so files can only be stored by the edge function. EXIF is dropped on the phone (canvas re-encode) and again on the server (APP1–APP15, comments and trailing data removed). JPEG only, 5 MB max. Tested end to end. | **Done** (milestone 2) |
| T9 | A kommun user sees deficiency details. | By default a kommun only gets aggregates and "approved / not yet" per shelter, through functions that coarsen the data in the database; a deficient shelter is indistinguishable from an unchecked one. Full status and details are separate policy levels, off by default. Tested at every level, including that switching back removes access. | **Done** (milestone 6) |
| T10 | Credential stuffing or brute force. | Supabase Auth rate limits; strong password policy (12+ characters, mixed case and digits). Planned: MFA for länsstyrelse users. | Partly done |
| T11 | XSS steals the session (stored in localStorage). | Content Security Policy in every production build (scripts only from the site itself, no inline scripts, `object-src 'none'`, `base-uri 'none'`), plus header-only rules in `dist/_headers` (`frame-ancestors 'none'`, HSTS). Preact escapes output by default; no `dangerouslySetInnerHTML`; fonts self-hosted. Checked for every role on a production build. | **Done** (milestone 7) |
| T12 | Abuse of the order link. | The link holds a random 24-character token that only identifies the order; it grants nothing. Opening it requires signing in as a member of the owner organisation, and RLS shows the order to nobody else (tested with another owner's account). Submitting is checked in the database. | **Done** (milestones 2 and 5) |
| T13 | Demo data is mistaken for real inspection results (fictional "brister" on real addresses). | The demo sits behind an access code; a DEMO strip on every screen says the organisations and statuses are made up; DEMO badge and PDF marking; fictional names, `example.com` addresses and phone numbers from PTS's fiction series (all tested); placeholder photos stamped DEMOBILD. | **Done** (milestone 7) |
| T14 | Hosting under foreign jurisdiction (US CLOUD Act). | Data stored in Stockholm (eu-north-1). Everything that matters is plain Postgres (SQL migrations, RLS), so it can move to Swedish-owned hosting. See `docs/hosting.md`. | Documented; decision before production |
| T15 | Personal data is kept longer or more broadly than needed (GDPR). | Minimal fields (name, phone); profiles visible only to colleagues; deleting a user removes their profile; profiles are not copied into the audit log. Export and deletion tooling planned. | Partly done |
| T16 | Forged or malformed submissions (missing items, fake photos, oversized input). | One database function validates everything: every checklist item answered exactly once, valid statuses, comments ≤ 2000 characters, control characters stripped, and a stored photo for every deficiency. A retried submit is idempotent. | **Done** (milestone 2) |
| T17 | Flooding submissions or uploads. | Per-user limits in the database: 20 submissions and 100 photos an hour, 40 photos per inspection. Returns HTTP 429. | **Done** (milestone 2) |
| T18 | Unsent drafts on a lost or shared phone. | Drafts (including photos) are kept on the device only until submitted, tied to the signed-in user, and deleted on sign-out after a warning. They are not encrypted at rest beyond what the phone provides. | Partly done; consider encrypting drafts |
| T19 | CSV injection: a description like `=HYPERLINK(...)` runs as a formula when the export is opened in Excel. | Every CSV cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with an apostrophe; all cells are quoted. | **Done** (milestone 3) |
| T20 | Contact details of responsible people leak (personal data). | Contacts are readable only by the owner organisation (not the länsstyrelse or kommun); only owner admins can change them; deletion removes them from all tasks; the audit log records changes without copying name, phone or email. | **Done** (milestone 4) |
| T21 | A simulation is mistaken for a real alert, or a real activation is triggered by accident. | A database check constraint allows only simulations; a confirmation before starting; a striped SIMULERING label on the plan and a banner on every screen; nothing is sent to anyone. | **Done** (milestone 4) |
| T22 | Live updates bypass access control. | Progress is polled through the same RLS-protected API instead of Supabase Realtime, because Realtime does not apply RLS to DELETE events. Completions are never deleted, only switched between done and not done. | **Done** (milestone 4) |
| T23 | A länsstyrelse orders or reviews shelters outside its län, or someone else issues orders in its name. | Order and review functions check the caller is an inspector or admin of that länsstyrelse and that each shelter lies in its län; shelters outside are skipped and counted. Tested for owners, kommuner, other län and anonymous callers. | **Done** (milestone 5) |
| T24 | Review results are altered after the fact. | Reviews and item decisions are append-only (updates rejected even for the service role); a new review supersedes the old and both stay in the history and the audit log. | **Done** (milestone 5) |
| T25 | Someone widens a kommun's access without authority. | Only a länsstyrelse admin for the kommun's län can change the level (not inspectors, owners, other län or the kommun itself); every change is audited with who made it; switching to the details level asks for confirmation. | **Done** (milestone 6) |
| T26 | Aggregates leak detail (e.g. checked minus approved hints at deficiencies). | Accepted: the spec asks for shares checked and approved per kommun, and the counts are not tied to individual shelters at the default level. Revisit if kommuner become very small. | Accepted risk |
| T27 | The demo login is abused to get into a project with real data. | `demo-login` only works when `DEMO_MODE=true` and only signs in as the four fixed demo users; the access code is compared in constant time, failures are throttled per IP, and the demo password never reaches the browser. Never set `DEMO_MODE` on a production project. | **Done** (milestone 7); keep `DEMO_MODE` off outside the demo |
| T28 | The public map publishes live occupancy: how many people are in which shelter, with which skills, in real time. In wartime that is targeting information. Until this fix, `checkins` was publicly readable and pushed over Realtime, `shelter_status` gave per-shelter counts of medical, leadership and technical staff, and `shelter_activity` gave every check-in timestamp. | In `supabase/schema.sql` (repo root): check-ins are readable only by their owner and are out of the Realtime publication; questionnaire answers are readable only by their author; `shelter_status` and `shelter_activity` are dropped. The public gets one coarse level per shelter (`shelter_load`: "filling" from 70 % of capacity, "full" from 100 %; fewer than 5 people is never listed), computed on the server as of the latest 15-minute boundary at least 30 minutes old (`occupancy_publication` gives that time). No counts, roles, needs, supplies or timestamps per check-in. Check-in and check-out times are set by the server and can't be backdated or reopened, and party sizes can only be added within 10 minutes of checking in, so a published level can't be changed afterwards or probed with test check-ins. One operator switch (`public_occupancy_enabled`, one SQL line) decides whether anything is published: **off by default**, a missing setting counts as off, and switching it off empties both endpoints for the website and the Android app at once, with no app update. Tested on a throwaway local Supabase stack: access as anonymous visitor, other user and owner; levels, delay and switch; and check-in, check-out and routing end to end in the browser. | **Done**; operator switches it off at heightened alert |
| T29 | Fake check-ins mark a shelter as full and steer people away from it (routing skips "full" shelters). | One active check-in per identity; party size capped at 20 adults and 30 children; new anonymous identities need hCaptcha; the effect only shows after 30–45 minutes; the operator switch turns the level and the skipping off. Residual: identities are still cheap without phone verification (see the comment at the end of `schema.sql`). | Partly done |

## Open risks needing a decision

1. **Session storage.** Supabase stores the session in localStorage. Acceptable with a
   strict CSP for the demo; revisit (e.g. shorter JWT lifetime, MFA) for production.
2. **Single region, single provider.** No backup outside Supabase in Phase 1.
3. **Public map questionnaire (GDPR data minimisation).** The check-in form still asks
   for special needs, roles, supplies and equipment, but after T28 nobody except the
   person and the operator can see the answers, and nothing uses them. Decide whether to
   stop collecting them or give them a defined purpose (e.g. handing them to
   räddningstjänsten during an activation).
4. **Public map check-ins never expire.** Someone who never checks out keeps counting
   toward "filling" or "full". Consider closing check-ins automatically after, say,
   48 hours.

## Public map: switching occupancy on, and what the Android app must change

Operator steps after running the new `supabase/schema.sql`:

1. Generate the capacities: `python supabase/build_capacity_csv.py`, then import
   `supabase/shelter_capacity.csv` into the `shelter_capacity` table (Table Editor →
   Import data from CSV). Nothing is published until that table has rows.
2. In peacetime, to publish delayed levels:
   `update operator_settings set enabled = true, updated_at = now() where key = 'public_occupancy_enabled';`
3. At heightened alert, or whenever in doubt, run the same statement with `enabled = false`.

The Android app (`skyddsrum-android/`, its own repository) reads `shelter_status` and
`shelter_activity` in `data/LiveStatus.kt`, and both are gone. Until it is updated,
those requests get HTTP 404 and the app shows its existing "Live status unavailable",
so nothing crashes, but the live dashboard is dead. To update it:

- Read `occupancy_publication?select=enabled,as_of` (always one row) and
  `shelter_load?select=shelter_id,level` (rows only for `filling` and `full`; a shelter
  that isn't listed has space). When `enabled` is false, show "Not published" with the
  website's text, and never infer "space".
- Show the level with "As of HH:MM, shown 30–45 minutes late"; `as_of` is UTC, so
  format it in local time.
- Remove the people, skills, resources and recent-activity views, `ShelterStatus`,
  `ActivityEvent`, `LiveMath.resourceLevel`, `bucketActivity`, and the `totalPeople` /
  `activeShelters` totals.
- Routing: a shelter is full when its level is `full` (replaces `LiveMath.isFull`);
  with nothing published, skip nothing.
- Poll every 5 minutes at most instead of every 30 seconds; the level only changes every
  15 minutes.
- Update its README ("Live status, read-only") and privacy text to match.
