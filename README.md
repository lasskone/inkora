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
endpoints, safe server/client boundaries) is complete, and three real vertical
slices are live: the **Product Scanner** searches the official eBay Browse API
and the **Supplier Scanner** searches the official CJdropshipping API, each
through a server-side adapter boundary; a **deterministic Product Matcher**
links the two (see
[Product Matcher](#product-matcher-ebay-listing--cj-supplier-candidates)); and a
**deterministic economics engine** turns a matched candidate into real landed
cost, profit, and margin (see
[Economics engine](#economics-engine-ebay-listing--cj-variant--landed-cost)).

The first **business persistence layer** is applied: identity and append-only
observations in Supabase, written from the economics route and read back through
a bounded history boundary (see
[Persistence and history](#persistence-and-history-ebay-listing--stored-observations)).
The **Opportunity Engine** is implemented: `GET /api/products/opportunity` scores a
real listing end-to-end — match, economics, competition, and demand — into a
deterministic, versioned, fully explainable 0–100 assessment with a confidence that
is computed independently of the score (see
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §9). Its history table is written
and code-complete but not yet applied to the database, so persistence reports
honestly until it lands — see [`docs/DATABASE.md`](./docs/DATABASE.md) §1.3.

The **Opportunity Scanner** is implemented: a bounded, user-triggered pipeline that
turns a search window into a ranked set of assessments — matching each selected
listing against CJdropshipping, computing landed-cost economics, and scoring it
through the Opportunity Engine — with per-item failure isolation, a
server-enforced budget, and a deterministic ranking that introduces no score of its
own (see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §15).

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

Current status: the first migration (`20260922025335_product_intelligence_v1.sql`)
is applied — 8 tables, 11 indexes, RLS on every table. The second
(`20260922040000_opportunity_engine_v1.sql`, the Opportunity Engine history table)
is written and code-complete but **not yet applied** — see
[`docs/DATABASE.md`](./docs/DATABASE.md) §1.3 and §6.8.

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

## Product Matcher (eBay listing → CJ supplier candidates)

The Product Scanner's **Find supplier** action, and the route behind it,
cross-reference a real eBay listing against the CJdropshipping catalogue. V1 is
**deterministic and text-only** — it deliberately contains no image similarity
and no AI/LLM call, so every result can be reproduced and explained.

```bash
# 1. Server-side boundary (itemId comes from an eBay search result)
curl 'http://localhost:3000/api/products/matches?itemId=v1%7C265983500898%7C0&q=wireless%20earbuds'
# 2. The UI
#    open http://localhost:3000/products, search, then "Find supplier" on a row
```

What the route guarantees:

- The listing is **re-resolved server-side** by replaying the *same* search the
  scanner issued — eBay reorders results across page sizes, so the item id is
  only meaningful within a matching result window.
- CJ discovery is **bounded and deduplicated**: at most 3 generated queries,
  candidates deduplicated by supplier id, failures preserved per query.
- Every candidate carries a `0–100` **confidence**, a `LOW` / `MEDIUM` / `HIGH`
  **band**, the ranked **signals** that produced it, and any **contradictions**
  that capped it. `HIGH` is only reachable with corroborating evidence beyond
  title agreement alone.
- Unknown supplier facts stay unknown: US warehouse inventory is enriched only
  for the top candidates and is reported as `CONFIRMED_AVAILABLE` /
  `CONFIRMED_NONE` / `UNKNOWN` — never silently converted to zero.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §8 for the pipeline and
§8.4 for the V1 limits and the intended image/AI extension points.

## Economics engine (eBay listing → CJ variant → landed cost)

The Product Scanner's **Calculate economics** action, and the route behind it,
take *one* eBay listing plus *one* matcher candidate the user selected, and
produce a landed cost, estimated profit, margin, and an explicit completeness
verdict. Like the matcher, it is **deterministic** — integer minor-unit money,
integer basis points, and documented selection policies — and it contains no
AI/LLM call, so every figure can be reproduced and explained.

```bash
# 1. Server-side boundary (itemId and supplierProductId come from results the
#    browser already received from the matcher route)
curl 'http://localhost:3000/api/products/economics?itemId=v1%7C265983500898%7C0&q=wireless%20earbuds&supplierProductId=<cjPid>'
# 2. The UI
#    open http://localhost:3000/products, search, "Find supplier", then
#    "Calculate economics" on one candidate
```

What the route guarantees:

- The browser never posts a price, a cost, or a shipping figure. The server
  **re-resolves** the eBay listing and **re-runs the bounded matcher to prove**
  the supplier product really is a candidate for it — a client-supplied cost
  would be a spoofable profit figure.
- Shipping cost is only ever CJ's own **real freight quote** for a specific
  variant id and destination. CJ's freight call is keyed on a variant id, so a
  catalogue candidate is resolved through the variant endpoint first. No quote
  ⇒ shipping is `null`, never a guessed or hardcoded number.
- Every monetary field carries its own provenance tag, and the result states
  whether it is `COMPLETE`, `PARTIAL`, or `UNAVAILABLE` and *why*. A non-USD
  listing is `UNAVAILABLE` — V1 performs no currency conversion and invents no
  exchange rate.
- Fees come from a **versioned rule set** (`ebay-us-1.0`) that always states its
  caveats: it cannot see the seller's subscription plan, the tax on the fee
  basis, or per-category maximums, so the fee is always `ESTIMATED`.
- Negative profit is reported as-is and never clamped to zero.

One user request costs a bounded set of upstream calls: 1 eBay search + ≤3 CJ
searches + 1 CJ variant query + 1–2 CJ freight calculations. Economics are
computed only for the candidate the user picked, never for all of them.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §10 for the money
conventions, selection policies, fee engine, cost basis, and completeness rules,
and [`docs/API_INTEGRATIONS.md`](./docs/API_INTEGRATIONS.md) §3.8 for the CJ
freight contract and §4.1 for the fee source and its limits.


## Persistence and history (eBay listing → stored observations)

Every economics computation is now **persisted** after it succeeds — the
listing's identity, its observed price, the matcher verdict, and the full
economics calculation — and can be read back later through a bounded history
boundary.

```bash
# 1. Server-side read boundary (the same item id the economics route resolved)
curl 'http://localhost:3000/api/products/history?itemId=v1%7C265983500898%7C0'
# 2. The UI
#    open http://localhost:3000/products, search, "Find supplier", then "History"
```

What the layer guarantees:

- **Identity and observations are separate tables.** A listing keeps its history
  when its title, price, or seller changes, because the anchor is the provider +
  external id. Observation tables are append-only — nothing is updated in place.
- **Deduplication is deterministic.** An observation is hashed over its business
  fields (timestamps and ids excluded), so the same observation seen again reuses
  one row, while a price or fee change always inserts.
- **Money stays integer minor units** end to end, margin is a separate
  percent-cents encoding, absent values stay `null` — never a fabricated zero —
  and a stored loss stays negative.
- **Persistence never degrades the economics result.** When persistence is not
  configured, or a write fails, the response says so honestly in its
  `persistence` field and the successful computation is still returned. The
  service key is server-only and never reaches the browser bundle; RLS is enabled
  on every table with no browser-facing policy, so the anon role is denied by
  default.
- **Reads are bounded and explicitly historical.** The page size is clamped to a
  hard ceiling and echoed back, results are most-recent-first, and every entry
  carries its own observation timestamp. The panel labels these as persisted
  observations, stated separately from the live figures above.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §13 for the persistence
layer and §14 for the read boundary, and [`docs/DATABASE.md`](./docs/DATABASE.md)
§6.1 for the applied schema, §6.8 for the Opportunity Engine history table, §7 for
deduplication, §8 for the money, margin, and null contract, and §12 for the index
strategy.


### Tests

```bash
npm test     # node:test; runs the matcher, adapter, economics, and persistence suites
```

Tests are wired through `scripts/test-register.mjs` (an import-map alias loader)
so `src/lib/**` specifiers resolve under Node without a bundler. Live
integration scripts (`scripts/live-matcher.mts`, `scripts/live-opportunity.mts`)
exercise the real eBay + CJ endpoints and are run manually after
`npm run build && npm run start`:

```bash
npx next start -p 3000
node --import ./scripts/test-register.mjs ./scripts/live-matcher.mts
node --import ./scripts/test-register.mjs ./scripts/live-opportunity.mts
```

`live-opportunity.mts` scores four real eBay queries through
`GET /api/products/opportunity` (with eBay-rotation retries and one
unnamed-supplier contract case) and prints each assessment's score, band,
confidence, components, and persistence outcome. Until the §6.8 migration is
applied, `persistence.status` reports `"failed"` rather than claiming a write;
it flips to `"ok"` once the table exists, with no code change.

`live-scanner.mts` runs three real, un-cherry-picked queries through
`POST /api/scanner/scan` — batch mode for each query, then a manual mode run that
mixes live ids with one that cannot resolve, to prove the scanner reports a
scrolled-out listing per item instead of matching it blindly or aborting the
batch. It prints the scan's budget, counts, wall-clock, every ranked verdict's
score / confidence / economics / persistence, and every isolated failure.

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

- **No watchlist, no scheduler.** The Opportunity Scanner is user-triggered and
  stateless: a scan deep-evaluates a bounded batch on demand and is never
  re-run on a schedule, and there is no watchlist or monitoring loop yet
  (see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §15.4).
- **No user-owned tables.** eBay *product search*, CJdropshipping *supplier
  search*, the deterministic *Product Matcher* linking them, and the deterministic
  *economics engine* costing a matched candidate are all implemented (see
  [eBay marketplace search](#ebay-marketplace-search-product-scanner),
  [CJdropshipping supplier search](#cjdropshipping-supplier-search-supplier-scanner),
  [Product Matcher](#product-matcher-ebay-listing--cj-supplier-candidates), and
  [Economics engine](#economics-engine-ebay-listing--cj-variant--landed-cost)), but
  there are no users, watchlists, connected accounts, or fee-rule tables yet —
  only the server-owned intelligence layer (see
  [`docs/DATABASE.md`](./docs/DATABASE.md) §3 and §11).
- **No currency conversion.** Economics are computed in USD only — a non-USD
  listing returns an `UNAVAILABLE` verdict rather than a converted estimate,
  because V1 invents no exchange rate.
- **No image similarity and no AI/LLM in matching or in money math.** The
  Product Matcher V1 is text-only by design, and the economics layer is pure
  arithmetic over rule sets; image and semantic signals are the documented
  extension points (see `docs/ARCHITECTURE.md` §8.4).
- **No adapters for paid supplier platforms** (Zendrop, Spocket) — these are
  excluded by policy (see `docs/API_INTEGRATIONS.md`).
- **No adapters for marketplaces outside the V1 scope** (Amazon, Etsy, TikTok
  Shop, Shopify, WooCommerce, AliExpress) — see `docs/MVP_SPEC.md` §6.
