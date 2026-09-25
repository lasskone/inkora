-- =============================================================================
-- Inkora — Dashboard read path
-- (docs/ARCHITECTURE.md §19, docs/DATABASE.md §6.11, §12.6)
--
-- The Dashboard is a read/aggregation surface over intelligence that is already
-- persisted (docs/MVP_SPEC.md §4.1). It adds no table and no column: it ranks
-- and counts the Opportunity Engine's own append-only assessments, so it needs
-- exactly one access path that did not exist before —
--
--   the most recent N assessments ACROSS ALL scopes,
--   ordered by calculated_at DESC, bounded by LIMIT.
--
-- Why the existing indexes cannot serve it. `opportunity_observations` currently
-- carries two indexes (docs/DATABASE.md §12.2), and both lead with
-- `marketplace_product_id`:
--
--   idx_opportunity_observations_product_calculated
--     (marketplace_product_id, calculated_at DESC)
--   idx_opportunity_observations_pair_calculated
--     (marketplace_product_id, supplier_product_id, calculated_at DESC)
--     WHERE supplier_product_id IS NOT NULL
--
-- Both exist to answer "the newest N assessments FOR ONE listing". The
-- Dashboard asks the opposite question — newest N across every listing — so the
-- ordered column is the leading one, and neither index can satisfy it without a
-- full table scan and an in-memory sort. `opportunity_observations` grows with
-- every scan and every re-evaluation and is never pruned (it is history,
-- docs/DATABASE.md §7), so an unbounded sequential scan on a page load is a real
-- scaling defect, not a theoretical one.
--
-- One index fixes it, and one reader justifies it (docs/DATABASE.md §12.5 — an
-- index with no documented reader is a bug):
--
--   idx_opportunity_observations_calculated (calculated_at DESC)
--
-- serves the Dashboard's bounded assessment window read, which in turn feeds the
-- summary KPIs, the Top Opportunities ranking, the Needs Attention derivation,
-- the Recent Changes comparison, the Data Coverage distribution and the Recent
-- Activity feed. A backwards index scan returns the requested page and stops.
--
-- This is deliberately NOT an index on `score`: the ranking ladder starts with
-- the engine's score but is a multi-key tie-break ladder resolved in code over a
-- bounded set (docs/ARCHITECTURE.md §19.4), so a score index would serve no
-- reader that cannot be served from the bounded window.
--
-- No index is added for the watchlist, snapshot or seller reads the Dashboard
-- performs: those reuse access paths the watchlist and seller migrations already
-- created and documented (docs/DATABASE.md §12.3, §12.4).
-- =============================================================================

CREATE INDEX idx_opportunity_observations_calculated
  ON opportunity_observations (calculated_at DESC);

COMMENT ON INDEX idx_opportunity_observations_calculated IS
  'Serves the Dashboard''s bounded assessment window read: the most recent N assessments across all scopes, newest first (docs/DATABASE.md §12.6). Distinct from the two history indexes, which are scoped per listing.';
