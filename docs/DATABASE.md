# Inkora — Data Model (Supabase / PostgreSQL)

> **Status: Conceptual.** This document describes candidate domain entities.
> It is **not** an executed schema, and no migrations exist yet.

## 1. Principles

- Migrations are introduced **incrementally**, one reviewable unit at a time.
- Do **not** create a massive production schema prematurely.
- Every table attributable to a user is subject to **Row Level Security (RLS)**.
- Provenance and history are design constraints, not afterthoughts.

## 2. Entity classification

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

## 3. Candidate entities

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

## 4. Row Level Security expectations

- RLS **enabled** on every user-owned table.
- Policies: users see/modify only rows where `auth.uid() = user_id` (directly
  or via the owning watchlist/opportunity).
- The service role is used **server-side only**; the anon key must never be
  able to read another user's data.
- Supabase Storage buckets (if used) follow the same ownership rules.

## 5. Snapshot / history strategy (design constraint)

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