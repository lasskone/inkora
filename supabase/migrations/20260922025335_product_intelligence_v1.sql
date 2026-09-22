-- =============================================================================
-- Inkora — Product Intelligence Persistence V1
--
-- The first deliberate business persistence layer. It establishes a clean
-- historical foundation by separating STABLE PROVIDER IDENTITY from
-- TIME-VARYING OBSERVATIONS, so that re-scanning the same product never
-- overwrites what was observed before (docs/DATABASE.md §6).
--
-- Scope is intentionally minimal: only tables the currently validated pipeline
-- (eBay search → CJ search/variants → Product Matcher → Economics Engine)
-- actually produces. No user/watchlist, no opportunity score, no AI outputs,
-- and no tables for marketplaces/suppliers that have no adapter yet.
--
-- Conventions (docs/DATABASE.md):
--   * Money is stored as integer minor units (`bigint` cents) — the same
--     representation the economics layer computes in. No binary floating point
--     is ever used for financial values. See §8 (money).
--   * Every observation carries an `observed_at` (upstream/provider time) which
--     is distinct from `ingested_at` (database insertion time). See §9 (time).
--   * Every observation carries a `content_hash` used by the deterministic
--     deduplication policy. See §7 (deduplication).
--   * Provenance uses the project's three fixed categories. Derived Inkora
--     calculations are stored as such, never as source data. See §10.
--   * RLS is ENABLED on every table; these are internal server-owned
--     intelligence tables with NO browser-facing policies. See §11.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- UUID generation. pgcrypto provides `gen_random_uuid()`; it is loaded on every
-- Supabase project but lives in the `extensions` schema, so the call is
-- schema-qualified to avoid depending on a specific `search_path`.
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- Provenance domain: the project's three non-negotiable categories
-- (docs/ARCHITECTURE.md §7). Reused by every observation table.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'provenance' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.provenance AS ENUM ('OFFICIAL', 'OBSERVED', 'ESTIMATED');
  END IF;
END $$;

-- =============================================================================
-- 1. MARKETPLACE PRODUCT — stable provider identity
--
-- The smallest stable representation that identifies an eBay listing across
-- observations. It deliberately does NOT duplicate snapshot fields: titles,
-- images and prices are time-varying and live in the snapshot table.
--
-- Identity is provider + external id (never the title). eBay item ids are
-- opaque composite strings (e.g. `v1|265983500898|0`), so `external_id` is text
-- and is never assumed numeric.
-- =============================================================================
CREATE TABLE marketplace_products (
  id              uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  -- Provider/marketplace name ('ebay'). New marketplaces arrive as new rows,
  -- never by overwriting this column's meaning.
  marketplace     text        NOT NULL,
  -- The provider's own immutable identifier for this listing.
  external_id     text        NOT NULL,
  -- First time Inkora observed this provider identity. Never overwritten.
  first_seen_at   timestamptz NOT NULL,
  -- Most recent time Inkora observed this provider identity.
  last_seen_at    timestamptz NOT NULL,
  -- Database row timestamps; these are NOT the upstream observation time.
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Provider identity is unique. This is the anchor all snapshots hang off.
  CONSTRAINT marketplace_products_identity_unique
    UNIQUE (marketplace, external_id),
  CONSTRAINT marketplace_products_marketplace_nonempty
    CHECK (btrim(marketplace) <> ''),
  CONSTRAINT marketplace_products_external_id_nonempty
    CHECK (btrim(external_id) <> '')
);


-- =============================================================================
-- 2. MARKETPLACE PRODUCT SNAPSHOT — append-oriented observation
--
-- One observation of a marketplace listing at a point in time. Re-scanning the
-- same listing INSERTs here; it never UPDATEs an existing row (see the
-- deduplication policy below and docs/DATABASE.md §7).
--
-- Fields are exactly the time-varying values the normalized
-- `MarketplaceProduct` model exposes. Fields the provider did not return are
-- NULL — never fabricated.
-- =============================================================================
CREATE TABLE marketplace_product_snapshots (
  id                          uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  marketplace_product_id      uuid        NOT NULL REFERENCES marketplace_products(id),
  -- Descriptive, time-varying; never part of identity.
  title                       text        NOT NULL,
  image_url                   text,
  listing_url                 text,
  -- Money: integer minor units (cents). NULL when the provider returned none.
  price_cents                 bigint      CHECK (price_cents >= 0),
  currency                    text        CHECK (currency IS NULL OR btrim(currency) <> ''),
  condition                   text,
  seller_identifier           text,
  -- 0–100 as returned by the provider.
  seller_feedback_percentage  numeric(5,2) CHECK (seller_feedback_percentage >= 0 AND seller_feedback_percentage <= 100),
  buyer_shipping_cents        bigint      CHECK (buyer_shipping_cents >= 0),
  shipping_currency           text        CHECK (shipping_currency IS NULL OR btrim(shipping_currency) <> ''),
  location                    text,
  -- Provenance of the observed values above (OFFICIAL for the eBay slice).
  provenance                  public.provenance NOT NULL,
  -- Deterministic digest of the observed fields, for deduplication.
  content_hash                text        NOT NULL,
  -- When Inkora acquired this record from the provider (upstream time).
  observed_at                 timestamptz NOT NULL,
  -- When the row was inserted into the database. Deliberately distinct from
  -- observed_at; do not infer one from the other.
  ingested_at                 timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 3. SUPPLIER PRODUCT — stable provider identity
--
-- The supplier-side equivalent of `marketplace_products`. Identity is
-- supplier + CJ external product id (never the title).
-- =============================================================================
CREATE TABLE supplier_products (
  id              uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  -- Supplier/provider name ('cj').
  supplier        text        NOT NULL,
  -- The provider's own immutable product identifier.
  external_id     text        NOT NULL,
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT supplier_products_identity_unique
    UNIQUE (supplier, external_id),
  CONSTRAINT supplier_products_supplier_nonempty
    CHECK (btrim(supplier) <> ''),
  CONSTRAINT supplier_products_external_id_nonempty
    CHECK (btrim(external_id) <> '')
);

-- =============================================================================
-- 4. SUPPLIER PRODUCT SNAPSHOT — append-oriented observation
--
-- One observation of a CJ product at a point in time.
--
-- IMPORTANT semantics (docs/DATABASE.md §6.4): `catalog_reference_price_cents`
-- is CJ's catalogue-level minimum/reference price. It is NOT the exact cost of
-- any particular variant and is never stored as if it were. The variant-level
-- cost — the number economics actually uses — lives in
-- `supplier_variant_snapshots.price_cents`. Keeping both columns preserves the
-- distinction so a reference price is never mistaken for a definitive cost.
-- =============================================================================
CREATE TABLE supplier_product_snapshots (
  id                            uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  supplier_product_id           uuid        NOT NULL REFERENCES supplier_products(id),
  title                         text        NOT NULL,
  image_url                     text,
  product_url                   text,
  category                      text,
  -- Catalogue-level reference/minimum price. A LOWER BOUND, never a definitive
  -- variant cost. Distinct from supplier_variant_snapshots.price_cents.
  catalog_reference_price_cents bigint      CHECK (catalog_reference_price_cents >= 0),
  currency                      text        CHECK (currency IS NULL OR btrim(currency) <> ''),
  -- Search-level inventory summary when the endpoint provides one; NULL when
  -- unconfirmed. Never a substitute for a variant-level inventory observation.
  available_inventory           integer     CHECK (available_inventory >= 0),
  warehouse_country             text        CHECK (warehouse_country IS NULL OR btrim(warehouse_country) <> ''),
  shipping_origin               text,
  provenance                    public.provenance NOT NULL,
  content_hash                  text        NOT NULL,
  observed_at                   timestamptz NOT NULL,
  ingested_at                   timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 5. SUPPLIER VARIANT — stable variant identity
--
-- CJ variants are modeled deliberately rather than flattened into the parent
-- product: a variant has its own immutable CJ `vid`, its own SKU, and —
-- critically — its own cost. Economics cost a *specific variant*, so variant
-- identity must be first-class to keep that cost attributable over time.
--
-- Identity is supplier product + external variant id.
-- =============================================================================
CREATE TABLE supplier_variants (
  id                  uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  supplier_product_id uuid        NOT NULL REFERENCES supplier_products(id),
  -- The provider's own immutable variant identifier (CJ `vid`).
  external_id         text        NOT NULL,
  -- Provider SKU when the endpoint returns one. Nullable: not all variants
  -- carry one, and SKU is an inventory key, not an identity key.
  sku                 text        CHECK (sku IS NULL OR btrim(sku) <> ''),
  first_seen_at       timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- One variant id per supplier product.
  CONSTRAINT supplier_variants_identity_unique
    UNIQUE (supplier_product_id, external_id),
  CONSTRAINT supplier_variants_external_id_nonempty
    CHECK (btrim(external_id) <> '')
);

-- =============================================================================
-- 6. SUPPLIER VARIANT SNAPSHOT — variant cost / inventory observation
--
-- Time-sensitive observations of one variant. Inventory is highly time
-- sensitive: a historical quantity is never current stock, which is why these
-- rows are append-only and always carry `observed_at`
-- (docs/DATABASE.md §6.5).
-- =============================================================================
CREATE TABLE supplier_variant_snapshots (
  id                  uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  supplier_variant_id uuid        NOT NULL REFERENCES supplier_variants(id),
  -- Variant display title, when the endpoint returns one.
  title               text,
  -- THE variant cost economics actually uses, in minor units. NULL when the
  -- variant was observed without a usable price.
  price_cents         bigint      CHECK (price_cents >= 0),
  currency            text        CHECK (currency IS NULL OR btrim(currency) <> ''),
  -- Units available for this variant at this observation. NULL means
  -- unconfirmed — never read as zero and never read as current stock.
  available_inventory integer     CHECK (available_inventory >= 0),
  -- ISO 3166-1 alpha-2 codes of warehouses reporting stock for this variant.
  warehouse_countries text[],
  provenance          public.provenance NOT NULL,
  content_hash        text        NOT NULL,
  observed_at         timestamptz NOT NULL,
  ingested_at         timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 7. MATCH OBSERVATION — a Product Matcher result, stored as history
--
-- This is NOT a permanent statement that two products are identical. It is a
-- *match observation produced by a specific matcher version*: the confidence,
-- the signals and the contradictions are all stored, so the explanation stays
-- reconstructable and a future matcher version never retroactively rewrites
-- what an old observation meant (docs/DATABASE.md §6.6).
-- =============================================================================
CREATE TABLE match_observations (
  id                          uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  marketplace_product_id      uuid        NOT NULL REFERENCES marketplace_products(id),
  -- The marketplace observation this match was computed against.
  marketplace_snapshot_id     uuid        REFERENCES marketplace_product_snapshots(id),
  supplier_product_id         uuid        NOT NULL REFERENCES supplier_products(id),
  -- The supplier observation this match was computed against.
  supplier_snapshot_id        uuid        REFERENCES supplier_product_snapshots(id),
  -- The variant the match (or a later economics run) resolved, when known.
  supplier_variant_id         uuid        REFERENCES supplier_variants(id),
  -- Logic versioning: a historical match stays attributable to its logic.
  matcher_version             text        NOT NULL,
  -- 0–100 deterministic confidence.
  confidence                  numeric(5,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  confidence_band             text        NOT NULL CHECK (confidence_band IN ('LOW', 'MEDIUM', 'HIGH')),
  -- Full reasoning, so the verdict can be re-explained later. Never just a
  -- mysterious final score.
  signals                     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  contradictions              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  explanation                 text,
  content_hash                text        NOT NULL,
  -- When Inkora computed this match.
  calculated_at               timestamptz NOT NULL,
  ingested_at                 timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 8. ECONOMICS OBSERVATION — a historical economics calculation
--
-- A persisted calculation, not eternal truth. Every component is stored so the
-- figure can be re-derived and audited; a future fee-rule change must not
-- retroactively alter what an old calculation meant (docs/DATABASE.md §6.7).
--
-- NOTE: profit/margin may legitimately be NEGATIVE. There is deliberately NO
-- non-negativity constraint on those columns — a loss is reported as a loss.
-- =============================================================================
CREATE TABLE economics_observations (
  id                              uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  marketplace_product_id          uuid        NOT NULL REFERENCES marketplace_products(id),
  -- The marketplace observation the revenue side came from.
  marketplace_snapshot_id         uuid        REFERENCES marketplace_product_snapshots(id),
  supplier_product_id             uuid        NOT NULL REFERENCES supplier_products(id),
  -- The supplier observation the cost side came from.
  supplier_snapshot_id            uuid        REFERENCES supplier_product_snapshots(id),
  -- The variant that was costed, when one was resolved.
  supplier_variant_id             uuid        REFERENCES supplier_variants(id),
  -- The match observation this calculation was derived from.
  match_observation_id            uuid        REFERENCES match_observations(id),

  -- --- Marketplace revenue side (minor units) ------------------------------
  item_price_cents                bigint      CHECK (item_price_cents >= 0),
  buyer_shipping_cents            bigint      CHECK (buyer_shipping_cents >= 0),
  gross_marketplace_revenue_cents bigint      CHECK (gross_marketplace_revenue_cents >= 0),
  currency                        text        CHECK (currency IS NULL OR btrim(currency) <> ''),

  -- --- Supplier cost side (minor units) --------------------------------------
  supplier_product_cost_cents     bigint      CHECK (supplier_product_cost_cents >= 0),
  -- What the cost represents. This distinction is the difference between a
  -- defensible profit figure and a fabricated one.
  supplier_cost_basis             text        CHECK (supplier_cost_basis IN ('SELECTED_VARIANT', 'VARIANT_REFERENCE', 'CATALOG_MINIMUM')),
  supplier_shipping_cents         bigint      CHECK (supplier_shipping_cents >= 0),
  supplier_shipping_method        text,
  landed_cost_cents               bigint      CHECK (landed_cost_cents >= 0),

  -- --- Fees ------------------------------------------------------------------
  marketplace_fee_cents           bigint      CHECK (marketplace_fee_cents >= 0),
  fee_engine_version              text        NOT NULL,
  fee_rule_source                 text        NOT NULL,
  -- The full breakdown (component, rate, status, note) for auditability.
  fee_breakdown                   jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- --- Result ----------------------------------------------------------------
  -- May be negative: a loss is stored as a loss, never clamped to zero.
  estimated_profit_cents          bigint,
  -- Margin in "percent cents" (1/100 of a percent), matching the economics
  -- layer's own representation. May be negative.
  margin_percent_cents            bigint,
  completeness                    text        NOT NULL CHECK (completeness IN ('COMPLETE', 'PARTIAL', 'UNAVAILABLE')),

  -- --- Context and caveats ----------------------------------------------------
  -- All shipping quotes returned, not just the selected one.
  shipping_quotes                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
  shipping_destination            jsonb,
  assumptions                     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  warnings                        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Per-component provenance, preserved as-is from the economics result.
  provenance                      jsonb       NOT NULL DEFAULT '{}'::jsonb,

  content_hash                    text        NOT NULL,
  -- When Inkora computed this economics result.
  calculated_at                   timestamptz NOT NULL,
  ingested_at                     timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- INDEXES
--
-- Only access patterns the current application actually uses (see
-- docs/DATABASE.md §12). No speculative indexes for future features.
-- The UNIQUE constraints above already cover provider + external id lookups,
-- so no duplicate index is added for those.
-- =============================================================================

-- History reads: chronological observation history per product.
CREATE INDEX idx_marketplace_snapshots_product_observed
  ON marketplace_product_snapshots (marketplace_product_id, observed_at DESC);

CREATE INDEX idx_supplier_snapshots_product_observed
  ON supplier_product_snapshots (supplier_product_id, observed_at DESC);

CREATE INDEX idx_supplier_variant_snapshots_variant_observed
  ON supplier_variant_snapshots (supplier_variant_id, observed_at DESC);

-- Deduplication probe: find the most recent observation for a product fast.
CREATE INDEX idx_marketplace_snapshots_product_hash
  ON marketplace_product_snapshots (marketplace_product_id, content_hash, observed_at DESC);

CREATE INDEX idx_supplier_snapshots_product_hash
  ON supplier_product_snapshots (supplier_product_id, content_hash, observed_at DESC);

CREATE INDEX idx_supplier_variant_snapshots_variant_hash
  ON supplier_variant_snapshots (supplier_variant_id, content_hash, observed_at DESC);

-- Match/economics history for a marketplace product (the scanner's history
-- view and the historical read API).
CREATE INDEX idx_match_observations_marketplace_calculated
  ON match_observations (marketplace_product_id, calculated_at DESC);

CREATE INDEX idx_economics_observations_marketplace_calculated
  ON economics_observations (marketplace_product_id, calculated_at DESC);

-- Pair-side history: everything computed for one marketplace × supplier pair.
CREATE INDEX idx_match_observations_pair
  ON match_observations (marketplace_product_id, supplier_product_id, calculated_at DESC);

CREATE INDEX idx_economics_observations_pair
  ON economics_observations (marketplace_product_id, supplier_product_id, calculated_at DESC);

-- The economics → match back-reference (re-deriving a calculation's lineage).
CREATE INDEX idx_economics_observations_match
  ON economics_observations (match_observation_id);
-- =============================================================================
-- ROW LEVEL SECURITY
--
-- These are INTERNAL SERVER-OWNED intelligence tables (docs/DATABASE.md §11).
-- The browser never writes them, and never reads them directly: historical
-- reads happen only through the server-side history API, which sanitizes the
-- response. RLS is therefore ENABLED with NO policies for anon/authenticated
-- roles — which means the public (anon key) client can access none of them.
-- All writes and reads go through the trusted server boundary using the
-- service-role key, which is server-only and never bundled into the browser.
--
-- RLS is deliberately not disabled: it is the mechanism that keeps these
-- tables private. A user-owned table (watchlists, …) will arrive with its own
-- owner-scoped policies in a later, separately reviewed migration.
-- =============================================================================
ALTER TABLE marketplace_products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_product_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_product_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_variants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_variant_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_observations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE economics_observations        ENABLE ROW LEVEL SECURITY;

-- No policies are defined: with RLS enabled and no matching policy, the anon
-- and authenticated roles are denied all access to these tables by default.

-- =============================================================================
-- COMMENTS — schema self-documentation in the database itself.
-- =============================================================================
COMMENT ON TABLE  marketplace_products            IS 'Stable provider identity for a marketplace listing (provider + external id). Identity only; no time-varying fields.';
COMMENT ON TABLE  marketplace_product_snapshots    IS 'Append-only observation of a marketplace listing at a point in time. Prices in integer minor units.';
COMMENT ON TABLE  supplier_products                IS 'Stable provider identity for a supplier product (supplier + external id). Identity only.';
COMMENT ON TABLE  supplier_product_snapshots       IS 'Append-only observation of a supplier product. catalog_reference_price_cents is a reference/minimum, NOT a variant cost.';
COMMENT ON TABLE  supplier_variants               IS 'Stable identity for a supplier variant (supplier product + external variant id).';
COMMENT ON TABLE  supplier_variant_snapshots      IS 'Append-only observation of a supplier variant: cost and inventory. Never treat a historical quantity as current stock.';
COMMENT ON TABLE  match_observations              IS 'A Product Matcher result stored as history. Attributes confidence and full reasoning to a matcher version; not a statement that products are identical.';
COMMENT ON TABLE  economics_observations          IS 'A historical economics calculation with every component, fee version and caveat. Profit may legitimately be negative.';
COMMENT ON COLUMN marketplace_product_snapshots.price_cents                IS 'Listing price in integer minor units (cents). NULL when the provider returned none.';
COMMENT ON COLUMN supplier_product_snapshots.catalog_reference_price_cents IS 'Catalogue-level reference/minimum price in cents. A lower bound; never the definitive cost of a variant.';
COMMENT ON COLUMN supplier_variant_snapshots.price_cents                   IS 'The variant cost economics uses, in integer minor units.';
COMMENT ON COLUMN economics_observations.estimated_profit_cents            IS 'Estimated profit in cents. MAY BE NEGATIVE — a loss is stored as a loss, never clamped.';
COMMENT ON COLUMN economics_observations.margin_percent_cents              IS 'Margin in percent cents (1/100 of a percent). MAY BE NEGATIVE.';
COMMENT ON COLUMN marketplace_product_snapshots.observed_at                IS 'When Inkora acquired this record from the provider. Distinct from ingested_at.';
COMMENT ON COLUMN marketplace_product_snapshots.ingested_at                IS 'When the row was inserted into the database. Distinct from observed_at.';

