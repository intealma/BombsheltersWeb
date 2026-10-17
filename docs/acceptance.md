# Phase 1 acceptance criteria

How each criterion from the brief is met, and how it is verified. "Tests" refers to
`beredskap/tests/` (run with `npm test`); "Browser" means it was walked through in the
running app.

| # | Criterion | How it is met | Verified by |
|---|---|---|---|
| 1 | The existing public map works exactly as before. | The new app lives in `beredskap/` and is served under `/beredskap/`; the public map files are untouched. | Tests (`public-data.test.ts`: public GeoJSON unchanged); no changes to `index.html` from this work |
| 2 | A länsstyrelse user can bulk-order self-checks for shelters in one kommun and get a unique link per owner. | Dashboard: filter by kommun → "Välj alla i listan" → "Skapa förelägganden"; one link per owner organisation. | Tests (`orders.test.ts`); Browser (127 orders in Linköping, one link each for two owners) |
| 3 | An owner can complete a self-check on a phone, with photos. The länsstyrelse sees it on the map within seconds and can approve it or flag it. | Mobile self-check with local drafts and photos (EXIF stripped); the dashboard polls every 5 s; item-by-item review. | Tests (`self-check.test.ts`, `orders.test.ts`, `jpeg.test.ts`); Browser (submission visible on the dashboard after 2 s; reviewed as Platsbesök krävs) |
| 4 | An owner can log maintenance and export a PDF proving upkeep. | Append-only maintenance log with voiding; PDF and CSV export per shelter, CSV for the whole organisation. | Tests (`maintenance.test.ts`, `csv.test.ts`); Browser (entry with photo, voided entry, PDF and CSV inspected) |
| 5 | An owner can activate the 48h simulation and tick off tasks against the countdown. | "Aktivera höjd beredskap" starts a simulation-only 48-hour countdown; tasks ticked on shelter pages; progress per task and shelter. | Tests (`readiness.test.ts`); Browser (countdown, live ticks from another session, overdue view) |
| 6 | A kommun user sees readiness percentages for their municipality, but no deficiency details by default. | Kommun overview with shares checked and approved; coarse status by default; details only if the länsstyrelse changes the policy. | Tests (`kommun.test.ts`); Browser (coarse map; policy switch and back) |
| 7 | Automated tests prove that cross-organisation data access is blocked for every role. | Row-level security on every table, writes only through checked functions. | Tests: every role (two owners, caretaker, two länsstyrelser, two kommuner, no organisation, anonymous) against every table, plus deliberate leak checks that make the tests fail |
| 8 | No sensitive data is reachable from public endpoints or the public GeoJSON. | Nothing is granted to anonymous callers; the public GeoJSON has only four public fields; the bundle carries no secret keys, passwords or access codes. | Tests (`schema.test.ts`, `public-data.test.ts`, anonymous cases in every test file) |
| 9 | The demo can be seeded and reset with one command each. | `npm run db:reset` (schema + demo) and `npm run demo:reset` (demo only, also for a hosted project). | Tests (`demo.test.ts`); repeated resets give identical status counts |

## Not part of Phase 1 (by design)

- Real email delivery of order links (the demo shows and copies the link).
- The flood-risk layer, population weighting and public crowdsourced check-ins (Phase 2).
- Opening the app offline after a cold start (drafts survive a lost connection, but the
  page must have been opened once with a signal).
