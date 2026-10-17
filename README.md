# skyddsrum.se

A fast map of Sweden's roughly 64,000 bomb shelters (*skyddsrum*), plus **Beredskap**:
a login-gated readiness tool for property owners, länsstyrelser and kommuner.

| Part | Folder | Audience |
|---|---|---|
| Public map | repo root (`index.html`, `shelters.geojson`) | Everyone, no login |
| Beredskap | `beredskap/` | Owners, länsstyrelser, kommuner, login required |
| Docs | `docs/` | Threat model, hosting decision |

Readiness, deficiency and inspection data never reaches the public map.

All commands below are for **Windows PowerShell**.

---

## Public map

```powershell
Copy-Item config.example.js config.js   # then fill in your keys
python -m http.server 8723
```

Open <http://localhost:8723>.

### Data pipeline

```powershell
python fetch_shelters.py               # all shelters from MCF/MSB's WFS -> skyddsrum.geojson
python fetch_shelters_municipality.py  # adds kommun (needs the SCB Kommun shapefile in kommun_shapes/)
python trim_for_web.py                 # -> shelters.geojson (id, address, capacity, municipality)
```

---

## Beredskap

### Prerequisites

- Node.js LTS: `winget install OpenJS.NodeJS.LTS`
- Docker Desktop, running: `winget install Docker.DockerDesktop` (restart Windows after installing)

### First-time setup

```powershell
cd beredskap
npm install
Copy-Item .env.example .env
npm run db:start          # starts Supabase locally in Docker (the first run downloads images)
npx supabase status       # copy "API URL" and the anon/publishable key into .env
```

In `.env`, also set `DEMO_PASSWORD` (12+ characters with lower case, upper case and
digits) and `DEMO_ACCESS_CODE` (the code you share in meetings). Then create the
local secrets for the edge functions:

```powershell
Copy-Item supabase/functions/.env.example supabase/functions/.env   # same DEMO_PASSWORD and DEMO_ACCESS_CODE
npm run db:stop
npm run db:start          # restart so the functions pick up the secrets
```

Then load the database:

```powershell
npm run db:reset          # migrations + Östergötland shelters + the whole demo
```

### Run

```powershell
npm run dev               # http://localhost:5173/beredskap/
```

### Demo login

The login page shows a **role switcher**: enter the access code (`DEMO_ACCESS_CODE`)
and pick Fastighetsägare, Fastighetsskötare, Länsstyrelse or Kommun. **Byt roll** in the
top bar switches role without retyping the code (it is remembered for the browser tab).
The demo password never reaches the browser: a small edge function (`demo-login`)
checks the code and signs you in. It only runs when `DEMO_MODE=true`.

A striped DEMO strip and the DEMO badge are on every screen, and every PDF is marked.

You can also sign in with email; the password is `DEMO_PASSWORD`:

| Email | Role | Organisation (fictional) |
|---|---|---|
| `agare@example.com` | Fastighetsägare | Demo Fastigheter AB |
| `skotare@example.com` | Fastighetsskötare | Demo Fastigheter AB |
| `brf@example.com` | Fastighetsägare | Demo BRF Exempelgården |
| `norrkoping@example.com` | Fastighetsägare | Demo Bostäder Norrköping AB |
| `motala@example.com` | Fastighetsägare | Demo Fastighets AB Motala |
| `lansstyrelse@example.com` | Administratör, länsstyrelse | Demo Länsstyrelse Östergötland |
| `kommun@example.com` | Kommun | Demo Kommun Linköping |

See [docs/demo-script.md](docs/demo-script.md) for a 15-minute walkthrough of the meeting.

Supabase Studio (database UI) runs at <http://127.0.0.1:54323>.

### Self-check (förenklad kontroll)

Sign in as `skotare@example.com` or `agare@example.com`, tap a shelter, and work
through the checklist one item per screen:

- Each item gets OK, Brist or Ej tillämpligt. A deficiency (Brist) needs at least one photo.
- Everything is saved on the phone (IndexedDB) as you go. If the connection drops,
  the draft survives a reload, and submitting can be retried; it never creates a duplicate.
- Photos are shrunk and re-encoded on the phone, which drops GPS and other EXIF
  data. The `upload-photo` edge function strips metadata again on the server, then
  stores the file in a private bucket. Photos are only shown through links that
  expire after 5 minutes.
- Submitting shows a receipt, and **Ladda ner PDF** downloads a summary with photos.

The checklist is data, not code (`checklist_templates` and `checklist_items`), and the
current one is a **placeholder** until MCF or the länsstyrelse provides the official
checklist. To replace it, insert a new version and set it `active`.

### Maintenance log (underhållslogg)

Open a shelter and tap **Ny post**: date, type of work, what was done, who did it,
and optional photos. Like the self-check, an unsaved entry is kept on the phone.

The log is built to hold up as evidence, since the state does not compensate damage
caused by neglected maintenance:

- A saved entry cannot be edited or deleted, not even by the service role.
- A mistake is **voided** (makulerad) by an owner admin, with a reason. The entry
  stays in the log and in every export, marked as voided.
- Each entry shows both the date the work was done (the owner's statement) and the
  time it was registered (set by the server), so backdating is visible.

Exports: **Ladda ner PDF** and **Ladda ner CSV** per shelter, and on the start page
owner admins get **Hela underhållsloggen (CSV)** for every shelter. The CSV is
semicolon-separated UTF-8 with BOM, so it opens correctly in Swedish Excel, and
cells that start with `=`, `+`, `-` or `@` are neutralised.

### 48-hour readiness plan and simulation

Owners open **48-timmarsplan** from the start page.

- **Plan.** Each shelter gets five tasks from a template (placeholder until official
  guidance exists), each with an hour by which it must be done within the 48 hours,
  a responsible person and a backup. Owner admins create the plans for all shelters
  in one click and assign people on each shelter page.
- **Contact people.** Name, phone, optional email and role, and nothing more. Removing
  a contact (GDPR) also removes them from every task. The audit log records that a
  contact changed, but not the personal data.
- **Aktivera höjd beredskap.** An owner admin starts a **simulation**: a 48-hour
  countdown for the whole organisation. Caretakers tick tasks off on their phones,
  and the plan page shows progress per task and per shelter within about 5 seconds,
  with overdue tasks flagged. A striped SIMULERING banner is shown on every screen
  while it runs. The database only allows simulations (`is_simulation` must be true),
  and no messages are sent to anyone.

The demo seed creates fictional contact people. Their phone numbers come from the
series PTS reserves for fiction (070-174 06 05 to 070-174 06 99).

### Länsstyrelse dashboard (desktop)

Sign in as `lansstyrelse@example.com` and open **Länsstyrelsens översikt**.

- **Map and table** of every shelter in the län, coloured by status: Ej förelagd,
  Förelagd, Försenad, Inskickad, Godkänd, Brister, Platsbesök krävs. Each status also
  has its own shape and symbol, so colour is never the only cue.
- **Filters:** kommun, status, free-text search. Sort by status, capacity, due date,
  submission date or number of deficiencies, and export the list as CSV.
- **Orders (förelägganden):** select shelters in the table, click them on the map,
  Shift-drag a box on the map, or "Välj alla i listan" for a whole kommun. Choose a
  due date and create the orders. You get **one unique link per owner** to copy;
  no email is sent in the demo. Shelters without a registered owner, or with an open
  order already, are skipped and counted.
- **Live:** the dashboard checks for changes every 5 seconds. A submitted self-check
  appears as Inskickad, and the row flashes.
- **Review** item by item: Godkänd, Brist or Platsbesök krävs, with comments. The
  outcome follows from the items (a site visit weighs most). Reviews cannot be
  edited; a new review replaces the old one, and both are kept.

The owner opens the link, signs in, and sees the shelters in that order with
"Starta egenkontroll". The link only points to the order: someone from another
organisation who opens it sees nothing. Owners also see the review result on the
receipt and the status of every shelter on their start page.

### Kommun view

Sign in as `kommun@example.com` and open **Beredskapsöversikt**: the share of
shelters checked and approved, places in approved shelters, a map, and a list of
approved shelters to inform residents with.

What a kommun sees is a **policy** that a länsstyrelse admin sets per kommun, in the
"Kommunernas insyn" panel on the länsstyrelse dashboard:

| Level | The kommun sees |
|---|---|
| **Översiktlig** (default) | Aggregates, and per shelter only "Godkänd" or "Ej godkänd ännu". A deficient shelter looks exactly like one not yet checked. |
| Status per skyddsrum | Also each shelter's full status, but no answers, comments or photos. |
| Status, brister och foton | Also the submitted self-checks, deficiencies, photos and reviews. |

Kommuner get their data through two database functions that return exactly what the
level allows. The highest level works by widening the access rules, and only for
self-check data in that kommun; maintenance logs and plans are never shown.

After changing an edge function in `supabase/functions/`, restart the local stack
(`npm run db:stop`, then `npm run db:start`) so the new code is served.

### Seed and reset

```powershell
npm run demo:reset        # restores the demo state (keeps the schema); works on hosted too
npm run db:reset          # wipes the local database, re-applies migrations, then demo:reset
```

The demo is deterministic: every reset gives the same picture, with dates relative to
today. Across Östergötland it has about 115 ordered shelters, 17 overdue, 11 waiting for
review, 37 approved, 11 with deficiencies and 4 needing a site visit, plus a year of
maintenance history and a 48-hour plan for every Demo Fastigheter AB shelter. The photos
are drawn placeholders stamped DEMOBILD (`python scripts/make_demo_photos.py`).

If photo uploads fail with 503 after starting the stack, the local edge runtime has crashed.
Restart it with `docker restart supabase_edge_runtime_beredskap`.

If `npm run db:reset` stops with `DbSetupError: error running container`, run it again.
This is an occasional Docker timing hiccup, not a problem with the data.

The shelter seed (`supabase/seed/20_shelters.sql`) is generated from the pipeline output
and committed. To regenerate it, for example for more län:

```powershell
python scripts/build_shelter_seed.py              # Östergötland (län 05)
python scripts/build_shelter_seed.py --lan 05 06  # several län
```

### Test

```powershell
npm test                  # access control, every feature, the demo, database guarantees, public data
npm run typecheck
npm run build             # production build with Content Security Policy and dist/_headers
npm run preview           # serve the build on http://localhost:4173/beredskap/ (CSP active)
```

The tests create and remove their own organisations, users and shelters. They refuse to
run against anything but the local stack.

### Stop

```powershell
npm run db:stop
```

### Layout

```
beredskap/
  src/                  app (Preact + TypeScript), i18n/sv.json and en.json
  supabase/migrations/  schema, row-level security, audit log
  supabase/functions/   upload-photo edge function (EXIF stripping)
  supabase/seed/        kommuner and shelters (generated)
  scripts/              shelter seed builder, demo users
  tests/                access-control and schema tests
```

### Access model

| Role | Sees |
|---|---|
| Fastighetsägare, fastighetsskötare | Only shelters assigned to their organisation |
| Länsstyrelse | Every shelter in its län |
| Kommun | Every shelter in its kommun, with coarse status only |
| Not signed in | Nothing |

Shelters are assigned to owners only by an admin or the seed script. Owners cannot
claim them. Access is enforced by Postgres row-level security, not by the UI. See
[docs/threat-model.md](docs/threat-model.md) and [docs/hosting.md](docs/hosting.md).
