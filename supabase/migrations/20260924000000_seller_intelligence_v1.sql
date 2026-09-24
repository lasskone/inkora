-- =============================================================================
-- Inkora — Seller Intelligence V1 (stable seller identity + seller observations)
-- (docs/ARCHITECTURE.md §17, docs/DATABASE.md §6.10)
--
-- The Seller Scanner records exactly two new things, and nothing else:
--
--   1. a STABLE SELLER IDENTITY (marketplace + normalized seller handle), so a
--      seller's history has an anchor that does not move when their feedback,
--      listings or prices do;
--   2. time-stamped SELLER OBSERVATIONS — the feedback figures and the
--      context-bounded listing counts of one scan — appended, never updated.
--
-- Listing-level history is NOT re-invented here: it already lives in
-- marketplace_products + marketplace_product_snapshots, and the scanner reads
-- and appends through that existing append-only layer. This migration only adds
-- the seller-side anchor, the one access path the seller reads need, and the
-- observation rows that make seller feedback comparable over time
-- (docs/DATABASE.md §6 — identity and observation are separate tables).
--
-- Minimal by design: no seller "score", no sales, no revenue, no demand columns
-- — the marketplace does not expose them and the scanner does not invent them
-- (docs/API_INTEGRATIONS.md §2 "Hard constraint on sales data").
--
-- Ownership: no user-authentication layer exists yet, so this is server-managed
-- single-owner internal data — NOT fake user ids. RLS is enabled with no
-- policies, as on the intelligence tables; only the service role (server-only,
-- never browser-bundled) reaches these tables.
-- =============================================================================

-- =============================================================================
-- 1. MARKETPLACE SELLERS — stable provider identity
--
-- Identity only: no feedback, no listing counts, nothing that changes between
-- two scans. Those live in the observation table below. The `username` column
-- holds the provider's display spelling (informational); history is keyed on
-- the normalized handle, which is stable and, for eBay, case-insensitively
-- matched upstream.
-- =============================================================================
CREATE TABLE marketplace_sellers (
  id                  uuid         PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  -- Provider/marketplace name ('ebay'). New marketplaces arrive as new rows.
  marketplace         text         NOT NULL,
  -- The provider's own normalized seller identifier. This is the anchor.
  external_seller_id  text         NOT NULL,
  -- Display spelling as returned by the provider. Informational, never identity.
  username            text,
  -- First time Inkora observed this seller. Never overwritten.
  first_seen_at       timestamptz NOT NULL,
  -- Most recent time Inkora observed this seller.
  last_seen_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketplace_sellers_identity_unique
    UNIQUE (marketplace, external_seller_id),
  CONSTRAINT marketplace_sellers_marketplace_nonempty
    CHECK (btrim(marketplace) <> ''),
  CONSTRAINT marketplace_sellers_external_seller_id_nonempty
    CHECK (btrim(external_seller_id) <> '')
);

-- =============================================================================
-- 2. MARKETPLACE SELLER OBSERVATIONS — append-only
--
-- One observation of a seller at a point in time, exactly the fields a scan
-- measures. Re-scanning the same seller INSERTs here; it never UPDATEs an
-- existing row, so an old observation stays attributable to the moment it was
-- taken. Feedback and counts carry separate provenance because they genuinely
-- differ (docs/ARCHITECTURE.md §7): feedback is OFFICIAL, counts are OBSERVED
-- and context-bounded.
--
-- No sales, revenue, demand or performance columns exist here on purpose.
-- =============================================================================
CREATE TABLE marketplace_seller_observations (
  id                          uuid             PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  marketplace_seller_id       uuid             NOT NULL REFERENCES marketplace_sellers(id),
  -- Provider-reported positive-feedback percentage, 0–100. NULL when the scan
  -- observed no listings and therefore no seller block.
  feedback_percentage         numeric(5,2)     CHECK (feedback_percentage IS NULL OR (feedback_percentage >= 0 AND feedback_percentage <= 100)),
  -- Provider-reported feedback score (lifetime count). NULL when unobserved.
  feedback_score              bigint           CHECK (feedback_score IS NULL OR feedback_score >= 0),
  -- How many of this seller's listings the marketplace reports *within the scan
  -- context*. OBSERVED and context-bounded: NOT the seller's whole inventory.
  observed_listing_count      bigint           CHECK (observed_listing_count IS NULL OR observed_listing_count >= 0),
  -- How many listings this scan actually received in its bounded page.
  sampled_listing_count       integer          NOT NULL CHECK (sampled_listing_count >= 0),
  -- The search context the counts are relative to. Part of the observation,
  -- because the numbers are meaningless without it.
  context_query               text             NOT NULL,
  -- Provenance, stored per group of fields (docs/DATABASE.md §10).
  provenance_feedback         public.provenance NOT NULL,
  provenance_counts           public.provenance NOT NULL,
  -- Deterministic digest of the observed fields, for deduplication.
  content_hash                text             NOT NULL,
  -- When Inkora acquired this record from the provider (upstream time).
  observed_at                 timestamptz      NOT NULL,
  -- When the row was inserted. Deliberately distinct from observed_at.
  ingested_at                 timestamptz      NOT NULL DEFAULT now()
);

-- =============================================================================
-- INDEXES — only the access paths the scanner actually executes.
-- =============================================================================

-- Seller identity lookup by provider + handle (the upsert path). UNIQUE does
-- double duty: it expresses the identity contract and makes a repeat scan an
-- upsert rather than a duplicate.
CREATE UNIQUE INDEX uq_marketplace_sellers_identity
  ON marketplace_sellers (marketplace, external_seller_id);

-- Chronological seller history, newest first: every read is "the seller's last
-- N observations", scoped by the seller identity first and ordered by time
-- descending because the reader stops at its limit.
CREATE INDEX idx_marketplace_seller_observations_seller_observed
  ON marketplace_seller_observations (marketplace_seller_id, observed_at DESC);

-- The one new access path over an EXISTING table: "which listings have been
-- observed for this seller". Without it that read is a sequential scan of every
-- snapshot; with it the seller's previously seen listings resolve index-only.
-- Leading column is the seller identifier because every read is scoped by it.
CREATE INDEX idx_marketplace_snapshots_seller_product
  ON marketplace_product_snapshots (seller_identifier, marketplace_product_id);

-- =============================================================================
-- ROW LEVEL SECURITY — same posture as the ten intelligence tables
-- (docs/DATABASE.md §11): RLS ENABLED, NO policies. With RLS on and no matching
-- policy, anon and authenticated are denied everything by default; only the
-- service role reaches these tables through src/lib/persistence/client.ts. Do
-- not weaken this to make the UI work — the UI goes through the API routes.
-- =============================================================================

ALTER TABLE marketplace_sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_seller_observations ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- COMMENTS — schema self-documentation in the database itself.
-- =============================================================================

COMMENT ON TABLE  marketplace_sellers                                      IS 'Stable provider identity for a marketplace seller (marketplace + normalized handle). Identity only; no time-varying fields. History is anchored here, never to a feedback figure or a listing count.';
COMMENT ON TABLE  marketplace_seller_observations                         IS 'Append-only observation of a seller at a point in time: feedback and context-bounded listing counts. No sales, revenue or demand columns exist here by design.';
COMMENT ON COLUMN marketplace_seller_observations.observed_listing_count  IS 'Count of the seller listings the marketplace reports WITHIN the scan context_query. OBSERVED and context-bounded — never the seller complete inventory.';
COMMENT ON COLUMN marketplace_seller_observations.sampled_listing_count   IS 'How many listings this bounded scan actually received in its page.';
COMMENT ON COLUMN marketplace_seller_observations.context_query           IS 'The search context the counts are relative to; the numbers are meaningless without it.';
COMMENT ON COLUMN marketplace_seller_observations.provenance_feedback     IS 'Provenance of the feedback fields: OFFICIAL when the provider returned them.';
COMMENT ON COLUMN marketplace_seller_observations.provenance_counts       IS 'Provenance of the listing counts: OBSERVED, because they are a bounded, context-scoped sample.';
COMMENT ON COLUMN marketplace_seller_observations.content_hash            IS 'sha256 of the canonical JSON of the observed fields. An identical observation reuses one row; a change always inserts.';
