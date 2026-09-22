# Inkora — Data Model (Supabase / PostgreSQL)

> **Status: Partially executed.** The first business migration is applied and
> described in §7; the rest of this document remains the candidate model the
> later migrations will draw from. Schema changes land one reviewed increment at
> a time — no placeholder or speculative object is created to satisfy a
> checklist.

## 1. Migration workflow (Supabase CLI)

Schema changes are made **only** through version-controlled migrations managed by
the project-local Supabase CLI. The CLI is committed to this repo, so every
developer runs the same version.

```bash
# Authenticate once (credentials persist to your user profile)
npx supabase login

# Bind this repository to the Inkora project
npx supabase link --project-ref <PROJECT_REF>

# Inspect current state BEFORE changing anything (read-only)
npx supabase migration list

# Create a migration (writes supabase/migrations/<timestamp>_<name>.sql)
npx supabase migration new <descriptive_name>

# Apply pending migrations to the linked remote project
npx supabase db push
```

### 1.1 Remote inspection before any change

Never apply schema work blind. Before writing or applying a migration, inspect
the remote structure (metadata only — never dump user data):

- `npx supabase migration list` — what is already applied.
- Dashboard → Table Editor / Database → Schemas — existing tables and schemas.

If the project contains **pre-existing objects that are not Inkora's**, they are
preserved untouched. Do not attempt to force a clean local state onto a
populated remote database.

### 1.2 Non-destructive policy

- **Never run `supabase db reset` against the linked/remote project.** It is
  destructive and drops data. It is only acceptable against a throwaway local or
  branch database.
- There is no "apply and hope" — a migration is reviewed before `db push`.
- Migrations are append-only history. A bad migration is fixed by a new
  migration, not by editing an applied one.

### 1.3 Current status

- `supabase/` scaffold exists (`config.toml`, `.gitignore`).
- **The first migration is applied**: `supabase/migrations/
  20260922025335_product_intelligence_v1.sql` creates the product-intelligence
  schema — 8 tables (identity + append-only observations), 11 indexes, RLS
  enabled, and `pgcrypto` uuid defaults. See §7.
- GitHub is now authoritative for schema; every subsequent change arrives as a
  new, reviewed migration.

## 2. Principles

- Migrations are introduced **incrementally**, one reviewable unit at a time.
- Do **not** create a massive production schema prematurely.
- Every table attributable to a user is subject to **Row Level Security (RLS)**.
- Provenance and history are design constraints, not afterthoughts.
- Never create placeholder or speculative objects just to have a migration.

## 3. Entity classification

Entities fall into three buckets. Only bucket **A** should be created during
early MVP implementation, and only when the consuming feature is actually
built.

### A. Likely MVP tables

`users`, `marketplaces`, `marketplace_listings`, `products`,
`product_identifiers`, `sellers`, `product_snapshots`, `suppliers`,
`supplier_products`, `supplier_variants`, `supplier_stock`, `product_matches`,
`searches`, `watchlists`, `watchlist_items`, `opportunities`, `fee_rules`.

### B. Future tables

`connected_accounts`, `seller_snapshots`, `supplier_stock_snapshots`,
`shipping_quotes`, `keywords`, `opportunity_scores` (as a separate historical
table).

### C. Conceptual — validate before migration

Any entity whose fields are still guesses. In particular, anything that depends
on an API field we have not yet observed (eBay seller analytics shape, CJ
shipping-quote shape, etc.). **Validate against real API responses first.**

## 4. Candidate entities

For each: purpose, important fields, relationships, provenance, history.

### users
- **Purpose:** authenticated Inkora user.
- **Fields:** id (uuid, Supabase auth), email, created_at.
- **Relationships:** owns watchlists, searches, connected_accounts.
- **RLS:** users read/update only their own row.

### connected_accounts *(future)*
- **Purpose:** a user's OAuth grant against a marketplace (e.g. eBay).
- **Fields:** user_id, marketplace_id, external_user_id, scopes,
  token_metadata (encrypted at rest; never plaintext), status, created_at.
- **Security:** RLS enforced; token material never exposed to the frontend.

### marketplaces
- **Purpose:** the small, controlled list of marketplaces Inkora supports.
- **Fields:** code (e.g. `ebay`), name, region/market, status
  (active/planned), api_base_url.
- **Relationships:** 1‑N marketplace_listings, sellers.

### marketplace_listings
- **Purpose:** a concrete live listing on a marketplace.
- **Fields:** marketplace_id, product_id (nullable until normalized), seller_id,
  external_listing_id, title, price, currency, condition, category, images,
  item_location, shipping_info, status, last_seen_at, raw_ref.
- **Provenance:** OFFICIAL for API-returned fields.
- **History:** listing change is captured via snapshots; keep `last_seen_at`
  fresh.

### products
- **Purpose:** Inkora's **normalized** product concept, independent of any one
  marketplace listing or supplier item.
- **Fields:** normalized title, brand, category, attributes, image_hashes,
  match_quality.
- **Relationships:** 1‑N marketplace_listings; 1‑N supplier_products via
  `product_matches`.

### product_identifiers
- **Purpose:** structured identity used for matching (GTIN/UPC/EAN/MPN).
- **Fields:** product_id, type (upc/ean/gtin/mpn/brand_model), value,
  provenance (OFFICIAL vs OBSERVED).
- **Note:** drives the Product Matcher's exact-match fast path.

### sellers
- **Purpose:** a marketplace seller.
- **Fields:** marketplace_id, external_seller_id, display_name, account_start,
  feedback_count, positive_feedback_pct, location.
- **Provenance:** OFFICIAL where the API returns it; OBSERVED where derived
  from listing pages.

### seller_snapshots *(future)*
- **Purpose:** time series of seller metrics for saturation/growth analysis.
- **Fields:** seller_id, captured_at, feedback_count, positive_feedback_pct,
  listing_count_est (ESTIMATED), provenance per metric.

### product_snapshots
- **Purpose:** the time-stamped price/competition observation for a listing.
- **Fields:** marketplace_listing_id (or product_id), captured_at, price,
  shipping_price, currency, watcher_count, offer_count, seller_count,
  raw_metrics (jsonb), provenance per metric.
- **Rule:** store **raw metrics independently of any final score**.

### suppliers
- **Purpose:** the controlled list of supplier ecosystems.
- **Fields:** code (e.g. `cj`), name, status, api_base_url.
- **Policy:** `zendrop` and `spocket` must never be seeded. See
  `docs/API_INTEGRATIONS.md`.

### supplier_products
- **Purpose:** a supplier catalogue product.
- **Fields:** supplier_id, external_product_id, title, category, images,
  attributes, origin_country, warehouses, last_synced_at.
- **Provenance:** OFFICIAL for API-returned fields.

### supplier_variants
- **Purpose:** the purchasable unit (SKU/VID).
- **Fields:** supplier_product_id, sku, vid, title, weight, dimensions,
  retail_price, cost_price, currency.
- **Provenance:** OFFICIAL.

### supplier_stock
- **Purpose:** current inventory for a variant, per warehouse where supported.
- **Fields:** supplier_variant_id, warehouse_code, quantity, available,
  last_updated.
- **Provenance:** OFFICIAL when returned by the supplier API.
- **Note:** US-warehouse availability is strategically important for the eBay
  strategy (see `docs/API_INTEGRATIONS.md`).

### supplier_stock_snapshots *(future)*
- **Purpose:** stock trend over time, especially US warehouse availability.

### shipping_quotes *(future)*
- **Purpose:** supplier → destination shipping cost and time.
- **Fields:** supplier_variant_id, warehouse_code, destination_country, method,
  cost, currency, estimated_days, quoted_at.
- **Provenance:** OFFICIAL when returned by the API; ESTIMATED when modeled.

### product_matches
- **Purpose:** the Product Matcher's output linking a marketplace product to a
  supplier product/variant.
- **Fields:** marketplace_product_id, supplier_product_id,
  supplier_variant_id (nullable), method (exact/gtin/semantic/image/…),
  confidence (0..1), status (confirmed/uncertain/rejected), matched_at,
  evidence (jsonb).
- **Rule:** `confidence < threshold` ⇒ status stays `uncertain`.
- See `docs/ARCHITECTURE.md` §8.

### searches
- **Purpose:** a scan the user (or system) ran (keyword/category/mode).
- **Fields:** user_id, marketplace_id, query, mode, filters (jsonb),
  result_count, ran_at.

### keywords *(future)*
- **Purpose:** tracked keyword entities for trend analysis.

### watchlists
- **Purpose:** a named monitored group.
- **Fields:** user_id, name, notes, created_at.
- **RLS:** owner-only.

### watchlist_items
- **Purpose:** a product/opportunity under monitoring.
- **Fields:** watchlist_id, product_id (or opportunity_id), added_at,
  alert_preferences (jsonb).
- **RLS:** owner-only, via the owning watchlist.

### opportunities
- **Purpose:** the evaluated Marketplace × Supplier × Product combination —
  the core output of the Opportunity Engine.
- **Fields:** product_id, marketplace_id, supplier_id, supplier_variant_id,
  selling_price, estimated_costs (jsonb), estimated_profit, margin,
  opportunity_score, score_model_version, computed_at, raw_metrics (jsonb).
- **Rule:** `raw_metrics` is stored **independently** of `opportunity_score`
  so scores can be recomputed under a new weighting version.
- **Provenance:** selling price OFFICIAL; profit, margin and score ESTIMATED.

### opportunity_scores *(future, history)*
- **Purpose:** time series of score movement per opportunity.

### fee_rules
- **Purpose:** transparent, versionable fee assumptions consumed by the Fee
  Engine.
- **Fields:** marketplace_id, payment_method, category (nullable), fee_type
  (insertion/final_value/payment/…), rate or fixed amount, currency,
  effective_from, effective_to, version, source (link to official docs),
  notes.
- **Rule:** every fee the Fee Engine applies must be traceable to a row here.

## 5. Row Level Security expectations

- RLS **enabled** on every user-owned table.
- Policies: users see/modify only rows where `auth.uid() = user_id` (directly
  or via the owning watchlist/opportunity).
- The service role is used **server-side only**; the anon key must never be
  able to read another user's data.
- Supabase Storage buckets (if used) follow the same ownership rules.

**Standing invariant:** no user-owned table may be exposed through Supabase
until it has undergone an explicit RLS review. No such table exists today — no
Inkora business tables have been created — so no RLS policies have been written
and none are speculatively defined. The first migration that creates a
user-owned table must include its RLS policies as part of that same reviewed
unit. Service-role access always remains server-only.

## 6. Snapshot / history strategy (design constraint)

Inkora must not depend solely on live API responses. Historical snapshots
should eventually allow detection of:

- price trends,
- supplier stock trends,
- competition changes,
- seller growth,
- listing changes,
- opportunity score movement.

Rules:

- Retain **raw** historical metrics independently of final scores.
- Every snapshot carries `captured_at` and a provenance tag per metric.
- Never prune raw metrics that are needed to recompute scores (pruning policy
  TBD).

The **architecture supports** historical intelligence; the **full snapshot
system is intentionally not implemented** in the foundation task.

### 6.1 Executed V1 — product intelligence

The first migration (`supabase/migrations/
20260922025335_product_intelligence_v1.sql`, applied) implements exactly the
slice the validated pipeline produces, and nothing more: no user or watchlist
tables, no opportunity score, no tables for marketplaces or suppliers that have
no adapter yet.

Eight tables, split by design intent:

| Table | Kind | Holds |
| --- | --- | --- |
| `marketplace_products` | identity | provider + external id of an eBay listing |
| `supplier_products` | identity | provider + external id of a CJ product |
| `supplier_variants` | identity | supplier product + external variant id |
| `marketplace_product_snapshots` | observation | listing price, seller, shipping — append-only |
| `supplier_product_snapshots` | observation | catalogue reference price — append-only |
| `supplier_variant_snapshots` | observation | variant cost and inventory — append-only |
| `match_observations` | observation | a Product Matcher verdict, with matcher version |
| `economics_observations` | observation | a full economics calculation, with fee engine version |

Identity rows carry no time-varying fields — a title, price, or seller change
never has to be migrated, because those live in the observation tables. Eleven
indexes cover the identity lookups and the most-recent-first observation reads.
RLS is enabled on all eight (§11). The read boundary over these tables is
`docs/ARCHITECTURE.md` §14.

## 7. Deduplication by content hash

Observations are deduplicated against the **latest stored row for the same
identity** by a sha256 of a canonical JSON encoding of the row's business fields
(`src/lib/persistence/content-hash.ts`).

- The canonical form sorts object keys, drops `undefined`, and encodes arrays in
  a stable order, so two equal observations hash identically.
- Timestamps and surrogate ids are **excluded** from the hash. "The same
  observation, seen again" reuses one row; a price, fee, or confidence change
  always inserts a new one.
- V1 probes the latest row only. If that probe fails, the writer **inserts**
  rather than guessing — a transient read error can never silently suppress a
  genuinely new observation.

## 8. Money, margin, and absent values

The database never stores a binary floating-point financial value, and never
stores a *guess* where a value was absent.

- **Money is integer minor units** — `bigint` cents, the same representation the
  economics layer computes in (`docs/ARCHITECTURE.md` §10.1). `$29.99` is stored
  `2999`. Conversion is exact in both directions; nothing is rounded at the
  boundary.
- **Margin is a separate encoding.** Percent is stored as *percent-cents* —
  1/100 of a percent — so `36.99%` is also `3699`. The two encodings coincide
  numerically and are still **not interchangeable**: money always formats to two
  decimals, margin does not, and they are served by separate helpers in
  `src/lib/persistence/mapping.ts`. Swapping them would silently invent or drop
  precision.
- **Absent values stay `null`.** A price, fee, or cost the provider did not
  return is stored `null` and read back `null` — never a fabricated `0`. A
  computed margin of `null` means no margin could be computed, not a 0% margin.
- **A stored loss stays negative.** `estimated_profit_cents` may legitimately be
  negative and is read back as a loss, never clamped to zero.

## 9. Observation time vs ingestion time

Every observation row carries two timestamps, and they mean different things:

- `observed_at` — when Inkora acquired the record from the provider. This is the
  timestamp a figure *belongs to*, and the one the history API surfaces.
- `ingested_at` — when the row was inserted into the database.

They diverge whenever acquisition and storage are not the same instant (a queued
or retried write). Trend reasoning uses `observed_at`; operational lag questions
use `ingested_at`. The history read API exposes `observed_at` only.

## 10. Provenance at rest

The `provenance` enum is the project's three fixed categories
(`docs/ARCHITECTURE.md` §7), created by the first migration and reused by every
observation table:

- `OFFICIAL` — a value returned by the provider's official API.
- `OBSERVED` — a value Inkora measured or normalized from an official response.
- `ESTIMATED` — a value Inkora *computed* (profit, margin, fee).

A derived figure is stored as `ESTIMATED`, never promoted to `OFFICIAL`, and the
tag travels from storage through the API to the UI without translation.

## 11. Row Level Security — applied

RLS is **enabled on all eight product-intelligence tables, with no policies
defined.** That is deliberate, and it is what makes them private:

- These are internal, server-owned intelligence tables. The browser has no
  legitimate path to them, so no browser-facing policy is written — there is
  nothing to select, and nothing to leak.
- With RLS enabled and no matching policy, the `anon` and `authenticated` roles
  are **denied all access by default**. Only the service role reads and writes
  them, through the server-only client in `src/lib/persistence/client.ts`, and
  the service key is never bundled into the browser.
- A user-owned table (watchlists, connected accounts) will arrive with its own
  owner-scoped policies in a later, separately reviewed migration. §5's standing
  invariant — no user-owned table is exposed until it has undergone an explicit
  RLS review — is unchanged, because no such table exists yet.
