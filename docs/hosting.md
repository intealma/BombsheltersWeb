# Hosting decision: Beredskap

## Decision (Phase 1, demo)

- **Database, auth, file storage:** Supabase, a **dedicated project** in **North EU
  (Stockholm), eu-north-1**. It is separate from the project behind the public map's
  check-ins, which allows anonymous sign-in.
- **Local development and tests:** the same stack in Docker via the Supabase CLI
  (`npm run db:start`). Tests never touch the hosted project.
- **Frontend:** a static build (`beredskap/dist`) served under `/beredskap/`. It contains
  no sensitive data. The host must support custom response headers (CSP, HSTS). This is
  decided at milestone 7, once we know where skyddsrum.se is hosted today.

## Why Supabase

Supabase gives authentication, Postgres with PostGIS, row-level security, private file
storage with signed URLs, and realtime updates in one service. It has an EU region in
Sweden and a free tier that needs no credit card. The alternative, Postgres plus a small
Node API, would mean building and running auth, file signing and realtime ourselves.
For a solo MVP that cost is not worth it.

## Caveats

- **Jurisdiction.** The data sits in Stockholm, but Supabase Inc. is a US company, so
  the US CLOUD Act may apply. That is acceptable for a demo with fictional
  organisations. For production with a länsstyrelse, expect a requirement for
  Swedish- or EU-owned hosting.
- **Portability.** To keep that move cheap, the schema, access rules and audit log are
  plain SQL migrations (`beredskap/supabase/migrations`) and Postgres RLS. The app uses
  supabase-js only for auth, queries and storage. A move to self-hosted Supabase or
  Postgres at a Swedish provider means changing connection settings and file storage,
  not rewriting access control.
- **Free tier.** Free projects pause after about a week without activity. Open the
  project before a meeting. The paid plan avoids pausing but needs a credit card; ask
  before upgrading.
- **Edge Functions.** Supabase's regional function invocation is not available in
  Stockholm. Functions run at the nearest edge location, and the data they touch stays
  in the Stockholm database.
