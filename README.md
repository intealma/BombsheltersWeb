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
digits). Then load the database:

```powershell
npm run db:reset          # migrations + Östergötland shelters + demo users
```

### Run

```powershell
npm run dev               # http://localhost:5173/beredskap/
```

Sign in with one of the demo users. The password is `DEMO_PASSWORD` from your `.env`.

| Email | Role | Organisation (fictional) |
|---|---|---|
| `agare@example.com` | Fastighetsägare | Demo Fastigheter AB |
| `skotare@example.com` | Fastighetsskötare | Demo Fastigheter AB |
| `brf@example.com` | Fastighetsägare | Demo BRF Exempelgården |
| `lansstyrelse@example.com` | Handläggare | Demo Länsstyrelse Östergötland |
| `kommun@example.com` | Kommun | Demo Kommun Linköping |

Supabase Studio (database UI) runs at <http://127.0.0.1:54323>.

### Seed and reset

```powershell
npm run db:reset          # wipes the local database and restores the demo state
npm run seed:users        # recreate only the demo organisations, users and assignments
```

The shelter seed (`supabase/seed/20_shelters.sql`) is generated from the pipeline output
and committed. To regenerate it, for example for more län:

```powershell
python scripts/build_shelter_seed.py              # Östergötland (län 05)
python scripts/build_shelter_seed.py --lan 05 06  # several län
```

### Test

```powershell
npm test                  # access control, database guarantees, public data checks
npm run typecheck
npm run build
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
