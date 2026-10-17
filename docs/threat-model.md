# Threat model: Beredskap

Status: draft for Phase 1 (demo MVP), October 2026. Updated after milestone 4 (48-hour plan). Review at every milestone.

Beredskap is the login-gated part of skyddsrum.se. Property owners run self-checks
(*förenklad kontroll*), keep maintenance logs and 48-hour plans. Länsstyrelser issue
orders and review results. Kommuner see aggregate readiness. The public map is a
separate, unauthenticated page and is out of scope here, except where noted under
open risks.

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
| T9 | A kommun user sees deficiency details. | Kommun policies expose only aggregate status; details behind a configurable policy that defaults to off. | Milestone 6 |
| T10 | Credential stuffing or brute force. | Supabase Auth rate limits; strong password policy (12+ characters, mixed case and digits). Planned: MFA for länsstyrelse users. | Partly done |
| T11 | XSS steals the session (stored in localStorage). | Strict CSP without inline scripts, Preact escaping by default, no `dangerouslySetInnerHTML`, self-hosted fonts. | CSP at deploy (milestone 7) |
| T12 | Abuse of the self-check link. | The link only identifies the order. Opening it requires sign-in as a member of the owning organisation. Submitting is checked in the database (owner admin or caretaker of the assigned organisation). | Submission rules **done** (milestone 2); order links in milestone 5 |
| T13 | Demo data is mistaken for real inspection results (fictional "brister" on real addresses). | Demo behind an access code, "DEMO – fiktiva statusar" on every screen, fictional organisations only, never on the public domain without login. | Milestone 7 |
| T14 | Hosting under foreign jurisdiction (US CLOUD Act). | Data stored in Stockholm (eu-north-1). Everything that matters is plain Postgres (SQL migrations, RLS), so it can move to Swedish-owned hosting. See `docs/hosting.md`. | Documented; decision before production |
| T15 | Personal data is kept longer or more broadly than needed (GDPR). | Minimal fields (name, phone); profiles visible only to colleagues; deleting a user removes their profile; profiles are not copied into the audit log. Export and deletion tooling planned. | Partly done |
| T16 | Forged or malformed submissions (missing items, fake photos, oversized input). | One database function validates everything: every checklist item answered exactly once, valid statuses, comments ≤ 2000 characters, control characters stripped, and a stored photo for every deficiency. A retried submit is idempotent. | **Done** (milestone 2) |
| T17 | Flooding submissions or uploads. | Per-user limits in the database: 20 submissions and 100 photos an hour, 40 photos per inspection. Returns HTTP 429. | **Done** (milestone 2) |
| T18 | Unsent drafts on a lost or shared phone. | Drafts (including photos) are kept on the device only until submitted, tied to the signed-in user, and deleted on sign-out after a warning. They are not encrypted at rest beyond what the phone provides. | Partly done; consider encrypting drafts |
| T19 | CSV injection: a description like `=HYPERLINK(...)` runs as a formula when the export is opened in Excel. | Every CSV cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with an apostrophe; all cells are quoted. | **Done** (milestone 3) |
| T20 | Contact details of responsible people leak (personal data). | Contacts are readable only by the owner organisation (not the länsstyrelse or kommun); only owner admins can change them; deletion removes them from all tasks; the audit log records changes without copying name, phone or email. | **Done** (milestone 4) |
| T21 | A simulation is mistaken for a real alert, or a real activation is triggered by accident. | A database check constraint allows only simulations; a confirmation before starting; a striped SIMULERING label on the plan and a banner on every screen; nothing is sent to anyone. | **Done** (milestone 4) |
| T22 | Live updates bypass access control. | Progress is polled through the same RLS-protected API instead of Supabase Realtime, because Realtime does not apply RLS to DELETE events. Completions are never deleted, only switched between done and not done. | **Done** (milestone 4) |

## Open risks needing a decision

1. **The public map already publishes live occupancy.** The existing check-in feature
   (`supabase/schema.sql` at the repo root) makes `checkins` publicly readable over
   Realtime. It also publishes per-shelter counts of people with medical, leadership and
   technical roles (`shelter_status`), and every check-in timestamp (`shelter_activity`).
   The Android app reads the same data. This contradicts the principle that
   occupancy must never be published in real time, and a länsstyrelse security reviewer
   could find it. Options: turn it off, delay and aggregate it, or add an automatic
   off-switch at heightened alert. **Decide before the pilot meetings.**
2. **Session storage.** Supabase stores the session in localStorage. Acceptable with a
   strict CSP for the demo; revisit (e.g. shorter JWT lifetime, MFA) for production.
3. **Single region, single provider.** No backup outside Supabase in Phase 1.
