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
- **The second migration is written, reviewed, and code-complete, but NOT yet
  applied to the linked project**: `supabase/migrations/
  20260922040000_opportunity_engine_v1.sql` creates `opportunity_observations`
  (§6.8), the history table the Opportunity Engine (docs/ARCHITECTURE.md §9)
  appends its assessments to. The engine, its route
  (`GET /api/products/opportunity`), its persistence modules, and its tests are
  all complete; only the table does not exist in the database yet. Until it does,
  the route still returns a full assessment and reports
  `persistence.status: "failed"` honestly rather than claiming a write (§11).
  Apply it from a shell that can reach Postgres (`supabase db push --linked`),
  then verify with `GET /rest/v1/opportunity_observations?select=id&limit=1` →
  `200`, after which persistence flips to `ok` with no code change (see
  `scripts/live-opportunity.mts`).
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
`shipping_quotes`, `keywords`. (Assessment history was originally listed here as a
future `opportunity_scores` table; it is now implemented as
`opportunity_observations`, see §6.8.)

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

### opportunity_scores *(implemented as `opportunity_observations` — see §6.8)*
- **Purpose:** time series of assessment movement per opportunity.
- **Status:** realized by the Opportunity Engine's history table, which stores
  one full, explainable assessment per row (score, band, confidence, components,
  factors, caps) rather than a bare score column, and appends instead of
  overwriting.

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
`docs/ARCHITECTURE.md` §14. The second migration adds a ninth observation table,
`opportunity_observations` (§6.8); the index strategy for both layers is §12.

### 6.8 The second migration — `opportunity_observations`

`supabase/migrations/20260922040000_opportunity_engine_v1.sql` adds **one
table**: `opportunity_observations`, the history layer for the Opportunity Engine
(docs/ARCHITECTURE.md §9). Written, reviewed, and code-complete — see §1.3 for its
application status.

It follows the V1 layer's conventions exactly: append-only, no money column (the
economics observation owns money and is referenced by id), `calculated_at` distinct
from `ingested_at`, and `content_hash` deduplication (§7).

**What a row is.** It is *not* a prediction and *not* a permanent verdict. It is:
"Opportunity Engine `<engine_version>`, given the evidence available at
`calculated_at`, assessed this opportunity at `<score>` (`<score_band>`) with
evidence confidence `<confidence>`."

| Group | Columns |
| --- | --- |
| Identity (mandatory scope) | `marketplace_product_id` (NOT NULL), plus `marketplace_snapshot_id` |
| Supplier scope (nullable) | `supplier_product_id`, `supplier_snapshot_id`, `supplier_variant_id` |
| Provenance links | `match_observation_id`, `economics_observation_id` |
| Verdict | `engine_version`, `score` (0–100), `score_band` (LOW/MEDIUM/HIGH), `confidence` (0–100), `confidence_level` (LOW/MEDIUM/HIGH) |
| Component summaries | `match_confidence`, `economics_completeness` (COMPLETE/PARTIAL/UNAVAILABLE), `competition_intensity` (0–100), `competition_verdict`, `demand_verdict`, `competition_query` |
| Full reasoning | `assessment` (the whole document), `factors`, `caps`, `explanation`, `caveats` (all jsonb) |
| Integrity | `content_hash`, `calculated_at`, `ingested_at` |

**Rules that the schema enforces or the writer guarantees:**

- **The whole assessment is stored, not just a score.** `assessment` carries all
  five components, every factor and cap that moved the result, the explanation and
  the caveats. A score without its reasoning is not auditable, and an old score
  must stay re-explainable after the engine moves on — with no recomputation.
- **`supplier_product_id` is NULLABLE on purpose.** An assessment with no matcher
  candidate is a legitimate, fully explainable (LOW-capped) verdict about a
  listing, so the row must exist. Written by
  `src/lib/persistence/opportunity-observations.ts`.
- **`confidence` is never derived from `score`.** Both are 0–100, but confidence
  measures evidence quality; they are computed independently and stored
  separately.
- **`competition_query` is stored.** A result count without the query that
  produced it is not a comparable number. NULL only when no evidence existed.
- **Versioning is a constraint, not a courtesy.** Changing any weight, cap,
  formula, or band threshold requires a new `engine_version`, precisely so old
  rows keep their meaning.

**Deduplication keys.** Same mechanism as every other observation (§7), scoped by
identity:

- Scope = `marketplace_product_id`, plus `supplier_product_id` when one exists.
- **A NULL supplier is not a filter value.** Assessments with no candidate are
  scoped by product alone, which is the honest scope for "this listing" — so the
  latest probe uses `IS NULL`, not `= anything`.
- The hash covers the full assessment document (components, factors, caps,
  explanation, caveats, versions), never the surrogate id or the timestamps. An
  identical assessment seen again reuses one row; any score, confidence, or
  component change inserts a new one.

**Read boundary.** `readOpportunityObservations` reads the most recent persisted
assessments for one listing, optionally narrowed to one marketplace × supplier
pair, most-recent-first and **always bounded by `limit`**. The engine never reads
this table directly; `readOpportunityEvidence` distills history plus priors into a
bounded `HistoryEvidenceSummary` (counts, oldest-first price observations, first /
last seen, and prior score/band/confidence/version). Snapshots are stored
most-recent-first while the evidence contract expects oldest-first; that reversal
happens exactly once, at the boundary in `summarizeEvidence`. The boundary the UI
will eventually consume is `docs/ARCHITECTURE.md` §14.

**Row limits.** No table-level cap; the bound is applied in code:
`maxPriorAssessments` (clamped, `≥ 1`) for the read, and the marketplace-snapshot
read is bounded by `maxPriceObservations`. A listing never observed before is a
normal first-assessment state, reported as such — not a failure.

**Persistence outcome contract.** `persistOpportunityAssessment` returns one of
`ok` (written, or reused by dedup, with an explicit `inserted` flag), `disabled`
(persistence not configured; the caller must not claim a write), or `failed`
(secret-free message). Storage is best-effort by design: a failure is reported and
never turns a successful assessment into an error — but it is never reported as
success either. That is what lets the route run today against a database where the
table does not yet exist. RLS posture: see §11.


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

RLS is **enabled on all eight product-intelligence tables, plus
`opportunity_observations` from the second migration (§6.8) — nine in total — with
no policies defined.** That is deliberate, and it is what makes them private:

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

## 12. Index strategy

Indexes are created **only for access paths the code actually executes.** No
speculative index is written to look thorough, and no index survives the query
that justified it being removed. This is why the count grows slowly: eleven
indexes for the whole product-intelligence layer, two more for opportunity
history.

### 12.1 V1 — product intelligence

Eleven indexes cover the two patterns the layer uses: a stable identity lookup
(provider + external id), and a most-recent-first observation read scoped to that
identity. Observation tables therefore index `(identity_id, observed_at DESC)` —
the identity first because every read is scoped by it, and time descending because
the reader wants the newest rows and stops at its `limit`.

### 12.2 Opportunity history

Two indexes, matching exactly the two reads the Opportunity Engine performs
(§6.8):

| Index | On | Serves |
| --- | --- | --- |
| `idx_opportunity_observations_product_calculated` | `(marketplace_product_id, calculated_at DESC)` | Chronological assessment history for one listing |
| `idx_opportunity_observations_pair_calculated` | `(marketplace_product_id, supplier_product_id, calculated_at DESC)` **partial** (`WHERE supplier_product_id IS NOT NULL`) | The same history narrowed to one marketplace × supplier pair |

The pair index is **partial** because rows with no matcher candidate legitimately
carry a NULL `supplier_product_id` (§6.8). Those rows are excluded from it rather
than stored as nulls the index cannot use; the product index still serves them,
because a NULL supplier is not a filter value — an assessment with no candidate is
scoped by product alone.

`calculated_at` (the assessment's own time) is the ordered column, not
`ingested_at`: history is read by when Inkora *assessed* the opportunity, not by
when the row happened to land.

### 12.3 Rules of thumb

- Leading column is always the scoping identity; the time column comes second,
  descending, because every read is "newest N for this thing".
- Never index a jsonb document column for querying — `assessment` and its
  siblings are stored for retrieval and audit, not for filtering.
- A new access path is added to this section in the same migration that adds the
  index. An index with no documented reader is a bug.
