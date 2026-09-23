-- =============================================================================
-- Inkora — Watchlist V1 (opportunity monitoring intent)
-- (docs/ARCHITECTURE.md §16, docs/DATABASE.md §6.9)
--
-- The watchlist is NOT a copy of marketplace, supplier, economics or
-- opportunity data: those live in the append-only observation tables and remain
-- the source of historical intelligence. This table records one new thing — the
-- user's intent to monitor an opportunity — as STABLE PROVIDER IDENTITY
-- (internal FKs to marketplace_products and optionally supplier_products),
-- never as a title, price or score, plus the query a re-evaluation replays to
-- re-resolve the listing.
--
-- Minimal and manual by design: ONE table, no alert / notification / scheduler
-- / scan-job / email tables (docs/MVP_SPEC.md §4.5), no ON DELETE CASCADE, so
-- removing a watch never deletes an observation.
--
-- Ownership: no user-authentication layer exists yet, so this is server-managed
-- single-owner internal data — NOT fake user ids. RLS is enabled with no
-- policies, as on the intelligence tables; only the service role (server-only,
-- never browser-bundled) accesses it. A future ownership model arrives as its
-- own reviewed migration; nothing here precludes it.
-- =============================================================================

CREATE TABLE watchlist_entries (
  id                       uuid         PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  -- Stable marketplace listing identity; without it an entry is not an
  -- opportunity. The FK never cascades.
  marketplace_product_id   uuid         NOT NULL REFERENCES marketplace_products(id),
  -- NULL is a distinct SCOPE, not a wildcard: a marketplace-only watch whose
  -- assessment is the LOW-capped no-supplier verdict.
  supplier_product_id      uuid         REFERENCES supplier_products(id),
  -- The query whose window surfaced this opportunity; a re-evaluation replays
  -- it. Operational metadata, not intelligence.
  replay_query             text         NOT NULL,
  -- Optional free-text note; never parsed, never used as identity.
  label                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- Bumped by the repository on every write; distinct from created_at.
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- Soft archive: NULL while active, set on removal. The row is retained so
  -- monitoring intent stays auditable, and the unique indexes below cover only
  -- active rows, so archiving frees the slot.
  archived_at              timestamptz
);

-- =============================================================================
-- UNIQUENESS — idempotent save, NULL as a distinct scope. Two partial indexes
-- express the two kinds of watch because a NULL supplier is a scope, not a
-- value: Postgres treats NULLs as mutually distinct in a unique index, so one
-- index over both columns could not protect the marketplace-only case.
-- =============================================================================

CREATE UNIQUE INDEX uq_watchlist_entries_active_pair
  ON watchlist_entries (marketplace_product_id, supplier_product_id)
  WHERE supplier_product_id IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX uq_watchlist_entries_active_marketplace_only
  ON watchlist_entries (marketplace_product_id)
  WHERE supplier_product_id IS NULL AND archived_at IS NULL;

-- The watchlist page: active entries, newest first, bounded. The partial
-- predicate mirrors the repository's active filter (docs/DATABASE.md §12).
CREATE INDEX idx_watchlist_entries_active_created
  ON watchlist_entries (created_at DESC)
  WHERE archived_at IS NULL;

-- =============================================================================
-- ROW LEVEL SECURITY — same posture as the nine intelligence tables
-- (docs/DATABASE.md §11): RLS ENABLED, NO policies. With RLS on and no matching
-- policy, anon and authenticated are denied everything by default; only the
-- service role reaches this table through src/lib/persistence/client.ts. Do not
-- weaken this to make the UI work — the UI goes through the API routes.
-- =============================================================================

ALTER TABLE watchlist_entries ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- COMMENTS — schema self-documentation in the database itself.
-- =============================================================================

COMMENT ON TABLE  watchlist_entries                        IS 'A user intent to monitor one marketplace (x supplier) opportunity. Identity only; it never duplicates an assessment. Server-managed single-owner data until a real ownership migration. Manual monitoring: no scheduler, no alerts.';
COMMENT ON COLUMN watchlist_entries.marketplace_product_id IS 'FK to the stable marketplace listing identity. Never cascaded: removing a watch never removes an observation.';
COMMENT ON COLUMN watchlist_entries.supplier_product_id    IS 'NULL is a distinct scope (marketplace-only watch), never a wildcard. See the two partial unique indexes.';
COMMENT ON COLUMN watchlist_entries.replay_query           IS 'The query whose window surfaced this opportunity; a re-evaluation replays it to re-resolve the listing. Operational metadata, not intelligence.';
COMMENT ON COLUMN watchlist_entries.label                  IS 'Optional free-text user note. Never parsed, never used as identity.';
COMMENT ON COLUMN watchlist_entries.archived_at            IS 'NULL while active; set when the user removes the entry. A soft archive that never deletes historical intelligence.';
