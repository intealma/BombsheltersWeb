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

## Deploying the demo to a hosted project (Stockholm)

You do these steps yourself, in your own Supabase account. The free plan is enough and
needs no credit card. Run everything from the `beredskap` folder.

1. In the Supabase dashboard, create a new project in **North EU (Stockholm)**. Keep the
   database password somewhere safe.
2. Link the folder to it and push the schema together with the kommuner and shelters:
   ```powershell
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push --include-seed
   ```
3. In the dashboard under **Authentication**: turn off "Allow new users to sign up" and
   anonymous sign-ins, and set the minimum password length to 12.
4. Deploy the edge functions and set their secrets:
   ```powershell
   npx supabase functions deploy upload-photo
   npx supabase functions deploy demo-login --no-verify-jwt
   npx supabase secrets set DEMO_MODE=true DEMO_ACCESS_CODE=<code> DEMO_PASSWORD=<password> ALLOWED_ORIGINS=<https://your-site>
   ```
5. Seed the demo against the hosted project. Put the hosted URL, anon key and service
   role key into `.env` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`;
   the service role key never gets a `VITE_` prefix), then:
   ```powershell
   npm run demo:reset
   ```
6. Build the app with the hosted values (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `VITE_DEMO_MODE=true`) and upload `dist/` to the static host under `/beredskap/`:
   ```powershell
   npm run build
   ```

Before the meeting, open the project once, since free projects pause after about a week
without activity.

## Security headers on the static host

`npm run build` writes the Content Security Policy into `index.html` and also creates
`dist/_headers` (Netlify and Cloudflare Pages read this file) with the header-only parts:
`frame-ancestors 'none'`, HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy` and `upgrade-insecure-requests`. On another host, set the same
headers, for example in nginx:

```nginx
location /beredskap/ {
  add_header Content-Security-Policy "<the policy from dist/_headers>" always;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;
  add_header Referrer-Policy no-referrer always;
  try_files $uri $uri/ /beredskap/index.html;
}
```

The policy allows scripts only from the site itself, images and API calls to the Supabase
project, and map tiles from tiles.openfreemap.org. It was checked against a production
build (`npm run preview`) for every role, including the map, photos and PDF export.
