# Inkora — Data Model (Supabase / PostgreSQL)

> **Status: Three of three MVP database parts executed.** All three business
> migrations are applied to the linked project and described in §6.1 (product
> intelligence), §6.8 (opportunity observations) and §6.9 (watchlist); the rest of
> this document remains the candidate model the later migrations will draw from.
> Schema changes land one reviewed increment at a time — no placeholder or
> speculative object is created to satisfy a checklist.

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
- **Migrations one through three are applied to the linked project**,
  verified with `supabase migration list --db-url`. The fourth is written and
  pending application:
  1. `supabase/migrations/20260922025335_product_intelligence_v1.sql` — the
     product-intelligence schema: 8 tables (identity + append-only observations),
     11 indexes, RLS enabled, `pgcrypto`/`extensions.gen_random_uuid()` defaults
     (§6.1).
  2. `supabase/migrations/20260922040000_opportunity_engine_v1.sql` —
     `opportunity_observations` (§6.8), the history table the Opportunity Engine
     (docs/ARCHITECTURE.md §9) appends its assessments to. Persistence flips to
     `ok` with no code change once the table exists (see `scripts/live-opportunity.mts`).
  3. `supabase/migrations/20260923000000_watchlist_v1.sql` — `watchlist_entries`
     (§6.9), the monitoring-intent table behind Watchlist V1
     (docs/ARCHITECTURE.md §16): 1 table, 3 indexes (2 of them partial unique),
     RLS enabled, no policies. Verified end-to-end against live providers by
     `scripts/live-watchlist.mts`.
   4. `supabase/migrations/20260924000000_seller_intelligence_v1.sql` —
      `marketplace_sellers` + `marketplace_seller_observations` (§6.10), the
      identity and append-only observation tables behind the Seller Scanner
      (docs/ARCHITECTURE.md §17): 2 tables, 3 indexes (one of them over the
      existing snapshot layer), RLS enabled, no policies. Exercisable end-to-end
      against live providers by `scripts/live-seller-scanner.mts`.
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

### watchlists / watchlist_items *(superseded — see `watchlist_entries`, §6.9)*
- **Purpose:** a named monitored group, and a product/opportunity under monitoring.
- **Status: not built as modeled.** Watchlist V1 deliberately ships **one** table,
  `watchlist_entries` (§6.9), with no groups and no alert preferences: an entry is
  scoped directly by provider identity, and the MVP has no alerts, no scheduler and
  no notification tables (docs/ARCHITECTURE.md §16, docs/MVP_SPEC.md §4.5). Grouped
  lists and per-item alert preferences remain a later, separately reviewed design —
  the entries below are the shape that design would draw from.
- **Prospective fields:** `watchlists` (user_id, name, notes, created_at);
  `watchlist_items` (watchlist_id, product_id or opportunity_id, added_at,
  alert_preferences jsonb).
- **RLS:** owner-only, once a user-ownership layer exists. `watchlist_entries` is
  server-managed single-owner data today, with RLS enabled and no policies (§11).

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
success either. RLS posture: see §11.


### 6.9 The third migration — `watchlist_entries`

`supabase/migrations/20260923000000_watchlist_v1.sql` — **applied.** This is the
monitoring layer's only table (docs/ARCHITECTURE.md §16). It is the *intent* table,
and it is deliberately minimal: **one table**, no alert / notification / scheduler /
scan-job / email tables (docs/MVP_SPEC.md §4.5), and **no `ON DELETE CASCADE`**, so
removing a watch never deletes an observation.

| Group | Columns |
| --- | --- |
| Identity (mandatory scope) | `marketplace_product_id` — NOT NULL, FK to `marketplace_products(id)`, never cascaded |
| Supplier scope (nullable) | `supplier_product_id` — FK to `supplier_products(id)`, never cascaded |
| Replay metadata | `replay_query` — NOT NULL; the query whose window surfaced the opportunity, replayed to re-resolve the listing |
| Note | `label` — optional free text; never parsed, never used as identity |
| Key | `id` — uuid primary key, `extensions.gen_random_uuid()` default |
| Timestamps | `created_at`, `updated_at` (bumped by the repository on every write, distinct from `created_at`), `archived_at` (NULL while active) |

**Rules the schema enforces or the writer guarantees:**

- **The table holds no money and no score.** Every figure the watchlist displays is
  read from the observation tables on request (§6.1, §6.8), so it is always a stored
  observation from a point in time — never a live claim about a listing's present
  price or profitability. An entry is a pointer to monitoring intent, not a data copy.
- **A NULL supplier is a distinct scope, not a wildcard.** A marketplace listing
  watched with a supplier candidate and watched marketplace-only are two different
  opportunities with two entries, two assessments and two histories. Because
  Postgres treats NULLs as mutually distinct in a unique index, one index over both
  columns could not protect the marketplace-only case — hence the two partial unique
  indexes below.
- **A save is idempotent.** Watching the same active scope twice reuses the existing
  entry (`action: "reused"`); it never duplicates a row and never overwrites the
  original's `created_at`.
- **Archive is soft and frees the slot.** `archived_at` is set, never deleted: the
  intent stays auditable, the timeline stays readable, and because both unique
  indexes cover **only active rows**, archiving frees both the cap slot and the
  uniqueness slot — the same scope can be watched again as a fresh entry with its
  own new history. There is no `DELETE` path.
- **Ownership.** No user-authentication layer exists yet, so this is server-managed
  single-owner internal data — **not fake user ids**. RLS is enabled with no
  policies, exactly as on the intelligence tables (§11); only the service role
  reaches it, through the server-only client. A future ownership model arrives as
  its own reviewed migration; nothing here precludes it.

**Uniqueness and indexes.** Three indexes, all partial over `archived_at IS NULL`,
matching exactly the accesses the repository executes (§12):

| Index | On | Serves |
| --- | --- | --- |
| `uq_watchlist_entries_active_pair` | `(marketplace_product_id, supplier_product_id)` **unique, partial** (`supplier_product_id IS NOT NULL AND archived_at IS NULL`) | Idempotent save of a pair watch; enforces "one active watch per marketplace × supplier" |
| `uq_watchlist_entries_active_marketplace_only` | `(marketplace_product_id)` **unique, partial** (`supplier_product_id IS NULL AND archived_at IS NULL`) | Idempotent save of a marketplace-only watch; NULL scoped by `IS NULL`, never `= anything` |
| `idx_watchlist_entries_active_created` | `(created_at DESC)` **partial** (`WHERE archived_at IS NULL`) | The watchlist page: active entries, newest first, bounded |

The two unique indexes are the schema's expression of scope semantics: they make a
repeat save a reuse rather than a duplicate, and they let an archive free the scope
for a future re-watch without ever deleting the original row.

**Reads and writes.** The repository (`src/lib/watchlist/watchlist-repository.ts`)
is the table's only writer: `addEntry` (idempotent, guarded by `countActiveEntries`
against the cap *before* the write), `archiveEntry` (sets `archived_at`; idempotent —
an already-archived row is a no-op success), and the scope lookup
`findActiveEntryIdByScope`. Reads are `findEntryById`, `countActiveEntries` and the
bounded active `listEntries`; every one is scoped `archived_at IS NULL`. Assessments
and snapshots are **never written here** — a re-evaluation persists its verdict
through `opportunity_observations` (§6.8) via the engine's own persistence module,
and the repository only *reads* the result back (`readLatestAssessment`,
`countAssessments`, `readAssessmentHistory`, `readPreviousObservation`, and the two
snapshot readers), so the watch table stays intelligence-free.

**Row limits.** No table-level cap; the bound is applied in code:
`WATCHLIST_MAX_ENTRIES` (100) active entries, checked *before* the write, with an
archived entry freeing its slot (docs/ARCHITECTURE.md §16.3). The list read is
bounded by `WATCHLIST_MAX_LIMIT` (50); the timeline by `WATCHLIST_HISTORY_LIMIT`
(12), served from §6.8.

### 6.10 The fourth migration — seller identity and seller observations

`supabase/migrations/20260924000000_seller_intelligence_v1.sql`. Two tables, plus
one index over an *existing* table (docs/ARCHITECTURE.md §17). It is written and
pending application (§1.3).

#### Tables

`marketplace_sellers` — identity only:

| Group | Columns |
| --- | --- |
| Identity | `marketplace` NOT NULL · `external_seller_id` NOT NULL, the normalized handle — the history anchor · UNIQUE(marketplace, external_seller_id) |
| Informational | `username` — display spelling only, never used as a key |
| Timestamps | `first_seen_at` (never overwritten), `last_seen_at`, `created_at`, `updated_at` |

`marketplace_seller_observations` — append-only:

| Group | Columns |
| --- | --- |
| Key | `id` uuid pk |
| Anchor | `marketplace_seller_id` uuid FK → `marketplace_sellers(id)`, no cascade |
| Feedback | `feedback_percentage` numeric(5,2), CHECK 0–100, NULL · `feedback_score` bigint, CHECK ≥ 0, NULL |
| Counts | `observed_listing_count` bigint NULL · `sampled_listing_count` integer NOT NULL |
| Context | `context_query` NOT NULL |
| Provenance | `provenance_feedback` · `provenance_counts` public.provenance NOT NULL (§10) |
| Dedup | `content_hash` NOT NULL |
| Time | `observed_at` NOT NULL · `ingested_at` NOT NULL DEFAULT now() |

#### Rules

- **Identity and observation are separate tables** (§6): the anchor never moves
  when feedback, listings or prices do. Identity is marketplace + normalized
  handle — the marketplace's own case-insensitive match key — so capitalization
  never splits a history.
- **Observations are appended, never updated.** An old observation stays
  attributable to the moment it was taken. Identical content re-observed reuses the
  latest row; any change inserts a new one.
- **No sales, revenue, demand or performance columns exist** — the marketplace does
  not expose them (docs/API_INTEGRATIONS.md §2), and Inkora does not derive them
  from listing presence.
- **Provenance is stored per field group**: feedback is `OFFICIAL` (published by the
  marketplace about the seller), the context-bounded listing counts are `OBSERVED`
  (read off a bounded sample) (§10).
- `observed_listing_count` is commented `OBSERVED` and context-bounded — how many
  of the seller's listings matched the scan's context, never their inventory size.
- **Ownership:** the same posture as the other intelligence tables — server-managed
  single-owner internal data. RLS ENABLED, no policies (§11).

#### Indexes (§12.4)

- `uq_marketplace_sellers_identity` — UNIQUE(marketplace, external_seller_id):
  double duty, the identity's uniqueness *and* its lookup path.
- `idx_marketplace_seller_observations_seller_observed` — (marketplace_seller_id,
  observed_at DESC): the latest-observation read for dedup and change detection.
- `idx_marketplace_snapshots_seller_product` — (marketplace, external_seller_id,
  product_id) over the *existing* snapshot table: the "which of this seller's
  listings have we already seen" read.

#### Reads and writes

`src/lib/sellers/seller-persistence.ts` is the only writer:

- `upsertSellerIdentity` — read-then-update-or-insert; `first_seen_at` is never
  overwritten.
- `appendSellerObservation` — dedup by `content_hash` against the latest row for
  that seller.
- `observeSellerListings` — bounded concurrency; appends through
  `marketplace_products` / `marketplace_product_snapshots` with the same
  content-hash dedup as every other observation (§13.2).
- `readPreviouslySeenListingExternalIds` plus latest-snapshot reads — the change
  detection read.

Writes are best-effort: a failure is reported in the component status, never
thrown, and never turns a scan into an error (docs/ARCHITECTURE.md §17.7). No
DELETE exists in this layer — observations are history.

#### Row limits

Bounded in code, not by the schema: at most `SELLER_SAMPLE_MAX` listing
observations per scan, `SELLER_RECENT_MAX` recent reads, and
`SELLER_OVERLAP_MAX` discovery windows (docs/ARCHITECTURE.md §17.3). The schema
stores what the bounded scan produced.

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
`opportunity_observations` from the second migration (§6.8) and `watchlist_entries`
from the third (§6.9), and `marketplace_sellers` and
`marketplace_seller_observations` from the fourth (§6.10) — twelve in total —
with no policies defined.** That is
deliberate, and it is what makes them private:

- These are internal, server-owned intelligence tables. The browser has no
  legitimate path to them, so no browser-facing policy is written — there is
  nothing to select, and nothing to leak.
- With RLS enabled and no matching policy, the `anon` and `authenticated` roles
  are **denied all access by default**. Only the service role reads and writes
  them, through the server-only client in `src/lib/persistence/client.ts`, and
  the service key is never bundled into the browser.
- `watchlist_entries` arrived with the **same posture** (§6.9): RLS enabled, no
  policies.
- The two seller tables arrived with the **same posture** (§6.10): RLS enabled,
  no policies, reached only by the service role through the server-only client. It is *not* a user-owned table — no user-authentication layer exists
  yet, so it is server-managed single-owner internal data, reached only by the
  service role. A genuinely user-owned table (grouped watchlists, connected
  accounts) will still arrive with its own owner-scoped policies in a later,
  separately reviewed migration. §5's standing invariant — no user-owned table is
  exposed until it has undergone an explicit RLS review — is unchanged, because no
  such table exists yet.

## 12. Index strategy

Indexes are created **only for access paths the code actually executes.** No
speculative index is written to look thorough, and no index survives the query
that justified it being removed. This is why the count grows slowly: eleven
indexes for the whole product-intelligence layer, two more for opportunity
history, three more for the watchlist, three more for seller intelligence — one
of them over an existing table.

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

### 12.3 Watchlist V1

Three indexes (§6.9), all partial over `archived_at IS NULL` because every read is
"active entries only":

| Index | On | Serves |
| --- | --- | --- |
| `uq_watchlist_entries_active_pair` | `(marketplace_product_id, supplier_product_id)` **unique, partial** | Idempotent save of a pair watch |
| `uq_watchlist_entries_active_marketplace_only` | `(marketplace_product_id)` **unique, partial** (`supplier_product_id IS NULL`) | Idempotent save of a marketplace-only watch |
| `idx_watchlist_entries_active_created` | `(created_at DESC)` partial | The watchlist page, newest first |

The two unique indexes do double duty: they enforce the scope contract (one active
watch per marketplace × supplier, and one per marketplace listing alone) *and* make
a repeat save a reuse rather than a duplicate. Note that uniqueness here is
**restricted to active rows on purpose** — it is what lets an archive free the scope
so the same opportunity can be re-watched later, without ever deleting the archived
row. This is also the case where a NULL is a **first-class value**: the
marketplace-only index keys on `supplier_product_id IS NULL`, because a NULL supplier
is a distinct scope, not a missing one.

### 12.4 Seller intelligence

| Index | On | Serves |
| --- | --- | --- |
| `uq_marketplace_sellers_identity` | `marketplace_sellers(marketplace, external_seller_id)` UNIQUE | seller identity lookup and upsert — double duty: the uniqueness constraint *is* the read path, so there is no separate lookup index |
| `idx_marketplace_seller_observations_seller_observed` | `marketplace_seller_observations(marketplace_seller_id, observed_at DESC)` | the latest-observation read, for dedup against the previous row and for change detection |
| `idx_marketplace_snapshots_seller_product` | `marketplace_product_snapshots(marketplace, external_seller_id, product_id)` | "which of this seller's listings have we already seen" — the change-detection read over the existing append-only layer |

The third is the first index this layer adds to an *existing* table. It documents
a reader that did not exist before this migration (§6.10), which is why it is
listed here rather than with the product-intelligence indexes: an index with no
documented reader is a bug (§12.5), and a new access path on a shared table is a
change to that table's contract, not a private detail of the seller layer.

### 12.5 Rules of thumb

- Leading column is always the scoping identity; the time column comes second,
  descending, because every read is "newest N for this thing".
- Never index a jsonb document column for querying — `assessment` and its
  siblings are stored for retrieval and audit, not for filtering.
- A new access path is added to this section in the same migration that adds the
  index. An index with no documented reader is a bug.
