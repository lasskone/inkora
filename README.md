# Inkora

**Cross-Marketplace E-Commerce Opportunity Intelligence Platform.**

Inkora answers: *What products are selling, where are they selling, how
competitive is the market, where can they be sourced, and which Marketplace ×
Supplier combination provides the strongest business opportunity?*

## MVP V1 scope

| Layer | V1 choice |
| --- | --- |
| Marketplace | **eBay** |
| Supplier / fulfillment | **CJdropshipping** |
| Database / backend | **Supabase (PostgreSQL)** |
| Source control | GitHub |
| Domain | [inkora.net](https://inkora.net) |

## Authoritative documentation

All project documentation lives in [`/docs`](./docs) and is the single source
of truth for AI-assisted development. **Read it before implementing anything.**

| Document | Role |
| --- | --- |
| [`docs/MVP_SPEC.md`](./docs/MVP_SPEC.md) | Authoritative MVP V1 product scope and boundaries. |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Architecture principles, adapters, core domain services, provenance. |
| [`docs/DATABASE.md`](./docs/DATABASE.md) | Supabase/PostgreSQL data model, entities, snapshots, RLS. |
| [`docs/API_INTEGRATIONS.md`](./docs/API_INTEGRATIONS.md) | eBay and CJdropshipping integration strategy and supplier policy. |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Phased roadmap and online-first validation strategy. |

## Repository status

**Application foundation stage — first marketplace and supplier slices
implemented.** The Next.js application skeleton (routing shell, health-check
endpoints, safe server/client boundaries) is complete, and two real vertical
slices are live: the **Product Scanner** searches the official eBay Browse API
and the **Supplier Scanner** searches the official CJdropshipping API, each
through a server-side adapter boundary. No persistence, matching, or scoring
exists yet — see [`docs/ROADMAP.md`](./docs/ROADMAP.md).

## Developer setup

Requires Node.js and npm.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables (never commit the real file)
cp .env.example .env.local   # then fill in real values

# 3. Run the development server
npm run dev            # http://localhost:3000

# 4. Validate
npm run lint           # ESLint
npm run typecheck      # TypeScript (tsc --noEmit)
npm run build          # production build
npm run start          # serve the production build
```

Health checks (both are live, non-cached endpoints):

- Application process: `GET http://localhost:3000/api/health`
- Supabase database reachability: `GET http://localhost:3000/api/health/db`

They are intentionally independent — a database outage must never make the basic
application-health endpoint fail. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Supabase setup

The project ships a **project-local** Supabase CLI (v2.117.0) — there is no
global install to manage. All commands below run through `npx` from the repo
root and use the scaffold in `supabase/`.

```bash
# 1. Authenticate (opens a browser; credentials persist to your user profile)
npx supabase login

# 2. Link this repo to the Inkora project (one-time)
npx supabase link --project-ref <PROJECT_REF>

# 3. Confirm you are linked to the right project
npx supabase projects list
```

`<PROJECT_REF>` is the 20-character reference in the Dashboard (Project Settings
→ General) and is the subdomain of your project URL
(`https://<PROJECT_REF>.supabase.co`). It is **not** a secret, but the service
role key, database password, and access tokens are.

**This repository is linked to the Inkora project** (project ref
`yvpkldzhbcxsslftettw`, region East US — North Virginia): `npx supabase projects
list` shows the `LINKED` marker against that row.

### Verifying database connectivity

With `.env.local` populated (see [Environment](#environment)), the Inkora server
can reach the live Supabase backend. Build and serve, then probe the database
endpoint:

```bash
npm run build && npm run start
curl http://localhost:3000/api/health/db
# {"status":"ok","service":"inkora-db","database":"reachable", ...}
```

`GET /api/health/db` performs a real, benign, read-only round-trip — it lists a
single auth user, so it requires **no business table to exist** — and reports
only a coarse `reachable` / `unreachable` verdict. It never returns credentials,
hostnames, ports, connection strings, SQL, or raw errors. `GET /api/health`
reports application-process health and is **independent of Supabase**, so a
database outage degrades `/api/health/db` without ever failing `/api/health`.
See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §2.2–2.3.

### Migrations

```bash
# Create a versioned migration file under supabase/migrations/
npx supabase migration new <descriptive_name>

# Review the generated SQL, then apply pending migrations
npx supabase db push

# See what is applied locally vs remotely
npx supabase migration list
```

Safe migration rules:

- **Never run a reset against the linked/remote project.** `supabase db reset`
  is destructive; it drops data. Do not run it against anything but a throwaway
  local/branch database.
- **Inspect before you change.** Before applying schema work, inspect the remote
  structure first (`npx supabase migration list`, Dashboard → Table Editor) and
  preserve any pre-existing objects that are not Inkora's to remove.
- **One reviewed unit at a time.** Migrations are incremental and must remain
  small and reviewable. Do not create a giant production schema prematurely.
- **Never create placeholder objects.** Do not add dummy tables, health tables,
  or speculative schemas just to have a migration. If no justified object is
  required yet, commit nothing.
- **GitHub is the source of truth.** Migration files are committed and reviewed;
  the remote database is brought into line with them, never the reverse.

Current status: no migrations exist yet and none are required — see
[`docs/DATABASE.md`](./docs/DATABASE.md).

## eBay marketplace search (Product Scanner)

The Product Scanner (`/products`) performs real keyword searches against the
official eBay **Browse API**. Credentials are server-side only and are read
from `.env.local` (never committed, never logged, never sent to the browser).

### Configuring eBay credentials

Add these to `.env.local` (variable names are also documented in
`.env.example`):

| Variable | Value |
| --- | --- |
| `EBAY_ENV` | `production` or `sandbox`. Selects the base URL and token endpoint. Defaults to `sandbox` if unset. |
| `EBAY_CLIENT_ID` | Your keyset **App ID** (client id). |
| `EBAY_CLIENT_SECRET` | Your keyset **Cert ID** (client secret). |
| `EBAY_SCOPE` | Optional. Defaults to the Browse API search scope. |

Obtain them from the eBay Developer dashboard:
**developer.ebay.com → My Application Keys → Application Keysets** (production
and sandbox keysets are separate). Copy the App ID and Cert ID of the keyset
that matches the environment you set in `EBAY_ENV`. `EBAY_REDIRECT_URI` is not
needed for this slice — it is only used by the authorization-code (user-scoped)
grant.

Production access to the Buy APIs additionally requires eBay's standard
production eligibility: the keyset must be approved for production use,
including eBay's Marketplace Account Deletion notification requirement
(satisfiable or exempted from the developer dashboard), and activation can lag
approval by some time. Until the keyset is approved, production token requests
fail with a `502 EBAY_AUTH_FAILED` whose `detail` names eBay's standardized
error code. The sandbox keyset works immediately.

### Running the slice

```bash
npm run build && npm run start
# 1. The server-side API boundary
curl 'http://localhost:3000/api/marketplaces/ebay/search?q=wireless%20earbuds'
# 2. The UI
#    open http://localhost:3000/products and search "wireless earbuds"
```

The response reports the active `environment` (`production` / `sandbox`) and the
provenance of every value (`OFFICIAL`); the UI shows both, so sandbox data is
never mistaken for production data. If `EBAY_CLIENT_ID` /
`EBAY_CLIENT_SECRET` are absent, the route returns a safe
`503 EBAY_NOT_CONFIGURED` instead of crashing, and the Product Scanner shows a
clear configuration message.

See [`docs/API_INTEGRATIONS.md`](./docs/API_INTEGRATIONS.md) §2.1 for the exact
endpoint, authentication flow, normalization, limitations and error handling,
and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §4 for the adapter
architecture.

### Verifying eBay connectivity

With `EBAY_ENV`, `EBAY_CLIENT_ID`, and `EBAY_CLIENT_SECRET` set in `.env.local`,
the slice is live against the real eBay API. Confirm it returns real data (note
the `environment` field and the per-item `provenance`):

```bash
npm run build && npm run start
curl -s 'http://localhost:3000/api/marketplaces/ebay/search?q=wireless%20earbuds' | head -c 400
```

A healthy production response opens with
`{"status":"ok","marketplace":"ebay","environment":"production",...}` and a
`products` array of normalized listings. A failed handshake returns a 5xx with a
sanitized `code` (`EBAY_AUTH_FAILED`, `EBAY_NOT_CONFIGURED`, ...) plus a
secret-free `detail` naming the eBay error code to check — no credentials or
upstream payloads are ever echoed.

## CJdropshipping supplier search (Supplier Scanner)

The Supplier Scanner at [`/suppliers`](http://localhost:3000/suppliers) searches
the supplier catalogue through the official **CJ API 2.0**. It is the
supplier-side counterpart to the eBay slice: the browser talks only to Inkora,
and the `CjAdapter` normalizes CJ's responses into the provider-independent
supplier model. Inventory and warehouse country are never guessed — they are
shown only after a real per-SKU inventory lookup, with an explicit
`CONFIRMED_AVAILABLE` / `CONFIRMED_NONE` / `UNKNOWN` verdict for US warehouses.

Credentials are server-side only and are read from `.env.local` (never
committed, never logged, never sent to the browser).

### Configuring CJ credentials

Add these to `.env.local` (variable names are also documented in
`.env.example`):

| Variable | Value |
| --- | --- |
| `CJ_API_KEY` | A **CJdropshipping API key** — not your sign-in password. |
| `CJ_TOKEN` | Optional. A pre-obtained access token that seeds the server cache. |
| `CJ_API_BASE_URL` | Optional. Defaults to the official CJ API 2.0 gateway. |

CJ's API 2.0 authenticates with an **API key**, not the account sign-in
email/password. Obtain one from your CJdropshipping account per CJ's docs: sign
in at [cjdropshipping.com](https://cjdropshipping.com), then *Apps → Install App
→ App Store → "Others" → "API"*, or open
`https://www.cjdropshipping.com/my.html#/authorize/API` → *API* tab → *Add API*
(name it, choose *API Key* as the type). The generated value goes in
`CJ_API_KEY` — never paste it into chat or a commit.

### Running the slice

```bash
npm run build && npm run start
# 1. The server-side API boundary
curl 'http://localhost:3000/api/suppliers/cj/search?q=wireless%20earbuds'
# 2. Per-SKU warehouse inventory for a selected product
curl 'http://localhost:3000/api/suppliers/cj/inventory?sku=<cj-sku>'
# 3. The UI
#    open http://localhost:3000/suppliers and search "wireless earbuds"
```

### Verifying CJ connectivity

With `CJ_API_KEY` set in `.env.local`, the slice is live against
the real CJ API. Confirm it returns real data (note the per-item `provenance` and
the honest inventory verdict):

```bash
npm run build && npm run start
curl -s 'http://localhost:3000/api/suppliers/cj/search?q=wireless%20earbuds' | head -c 400
```

A healthy response opens with
`{"status":"ok","supplier":"cj","query":"...","products":[...]}` and a
`products` array of normalized supplier listings. If `CJ_API_KEY`
is absent, the route returns a safe `503 CJ_NOT_CONFIGURED`
instead of crashing, and the Supplier Scanner shows a clear configuration
message. An authentication failure returns `502 CJ_AUTH_FAILED` whose `detail`
names CJ's numeric error code to check — no credentials or upstream payloads are
ever echoed.

See [`docs/API_INTEGRATIONS.md`](./docs/API_INTEGRATIONS.md) §3 for the exact
endpoint, authentication flow, inventory/warehouse semantics, limitations and
error handling, and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §5 for the
supplier adapter architecture.

## Environment

- Copy `.env.example` to `.env.local` (Git-ignored) and fill in real values.
  Next.js loads `.env.local` automatically for both `dev` and `start`.
- **Never commit `.env.local`** or any file containing real credentials. The
  template in `.env.example` contains variable names and placeholders only.
- Variables holding private credentials never use the `NEXT_PUBLIC_` prefix;
  `NEXT_PUBLIC_` values are embedded in client-side JavaScript and are public.
- Server-only variables (`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`) are read
  only in modules guarded by `import "server-only"`.
- Never print secrets, tokens, or connection strings in logs or API responses.

## What is intentionally absent

- No persistence, matching, or intelligence features yet: eBay *product search*
  and CJdropshipping *supplier search* are implemented (see
  [eBay marketplace search](#ebay-marketplace-search-product-scanner) and
  [CJdropshipping supplier search](#cjdropshipping-supplier-search-supplier-scanner)),
  but there is no database schema or migrations, no product
  matching, opportunity scoring, or watchlists.
- **No adapters for paid supplier platforms** (Zendrop, Spocket) — these are
  excluded by policy (see `docs/API_INTEGRATIONS.md`).
- **No adapters for marketplaces outside the V1 scope** (Amazon, Etsy, TikTok
  Shop, Shopify, WooCommerce, AliExpress) — see `docs/MVP_SPEC.md` §6.
