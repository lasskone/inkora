-- =============================================================================
-- Inkora — Opportunity Engine V1 persistence
--
-- The Opportunity Engine (docs/ARCHITECTURE.md §9) produces a deterministic,
-- versioned, explainable assessment of one marketplace × supplier opportunity:
-- a 0–100 score with a band, a separate evidence confidence, the five
-- components that fed them, and every factor and cap that moved the result.
--
-- This migration stores those assessments as *history*, in the same append-only
-- tradition as the rest of the intelligence layer (docs/DATABASE.md §6):
--
--   * An assessment is NEVER overwritten. A re-evaluation appends a new row, so
--     a historical score stays attributable to the exact engine version and the
--     exact evidence that produced it (docs/DATABASE.md §7).
--   * The whole assessment document is stored: components, factors, caps,
--     explanation and caveats. A score without its reasoning is not auditable,
--     and an old score must remain re-explainable after the engine moves on.
--   * `supplier_product_id` is NULLABLE on purpose. An assessment is a legitimate
--     verdict about a listing even when the matcher surfaced no candidate —
--     that is the LOW-capped, fully explainable case — so the row must exist.
--   * `competition_query` is stored because a competition figure without its
--     query is not a comparable number (docs/ARCHITECTURE.md §9.2).
--
-- Conventions follow the V1 layer exactly: no money column appears here (the
-- assessment carries no money of its own — the economics observation owns that,
-- and is referenced by id), `calculated_at` is the assessment's own time and is
-- distinct from `ingested_at`, and `content_hash` drives deduplication.
-- =============================================================================

-- =============================================================================
-- 9. OPPORTUNITY OBSERVATION — an Opportunity Engine assessment, as history
--
-- This is NOT a prediction and NOT a permanent verdict. It is "Opportunity
-- Engine <version>, given the evidence available at <calculated_at>, assessed
-- this opportunity at <score> (<band>) with confidence <confidence>".
-- =============================================================================

CREATE TABLE opportunity_observations (
  id                             uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  marketplace_product_id         uuid        NOT NULL REFERENCES marketplace_products(id),
  -- The marketplace observation the assessment was built against.
  marketplace_snapshot_id        uuid        REFERENCES marketplace_product_snapshots(id),
  -- NULL when the matcher surfaced no candidate for this listing. The assessment
  -- is still a complete, explainable verdict in that case.
  supplier_product_id            uuid        REFERENCES supplier_products(id),
  supplier_snapshot_id           uuid        REFERENCES supplier_product_snapshots(id),
  supplier_variant_id            uuid        REFERENCES supplier_variants(id),
  -- The observations this assessment was derived from, when they exist.
  match_observation_id           uuid        REFERENCES match_observations(id),
  economics_observation_id       uuid        REFERENCES economics_observations(id),

  -- --- Logic versioning -------------------------------------------------------
  -- A historical assessment stays attributable to the exact engine version that
  -- produced it. Changing any weight, cap, formula or band threshold requires a
  -- new version, precisely so old rows keep their meaning.
  engine_version                 text        NOT NULL,

  -- --- The verdict ------------------------------------------------------------
  -- 0–100, after every conservative gate has been applied.
  score                          numeric(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
  score_band                     text        NOT NULL CHECK (score_band IN ('LOW', 'MEDIUM', 'HIGH')),
  -- Evidence confidence, computed independently from the score. Same scale,
  -- deliberately never derived from it (docs/ARCHITECTURE.md §9.5).
  confidence                     numeric(5,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  confidence_level               text        NOT NULL CHECK (confidence_level IN ('LOW', 'MEDIUM', 'HIGH')),

  -- --- Component summaries (the full components live in `assessment`) ---------
  -- The matcher confidence the assessment used; 0 when no candidate was found.
  match_confidence               numeric(5,2) NOT NULL CHECK (match_confidence >= 0 AND match_confidence <= 100),
  economics_completeness         text        NOT NULL CHECK (economics_completeness IN ('COMPLETE', 'PARTIAL', 'UNAVAILABLE')),
  -- 0–100, higher meaning MORE competition. The score uses the inverse.
  competition_intensity          numeric(5,2) NOT NULL CHECK (competition_intensity >= 0 AND competition_intensity <= 100),
  competition_verdict            text        NOT NULL CHECK (competition_verdict IN ('INSUFFICIENT_EVIDENCE', 'APPEARS_LIMITED', 'APPEARS_MODERATE', 'APPEARS_BROAD')),
  demand_verdict                 text        NOT NULL CHECK (demand_verdict IN ('INSUFFICIENT_EVIDENCE', 'WEAKLY_SUPPORTING', 'SUPPORTING')),

  -- --- Provenance of the competition figures ----------------------------------
  -- A result count is meaningless without the query that produced it, so the
  -- query is part of the persisted record. NULL only when no evidence existed.
  competition_query              text,

  -- --- The complete reasoning, stored once ------------------------------------
  -- Every component, factor, cap, explanation line and caveat, so the assessment
  -- can be re-explained in full at any later time without recomputing anything.
  assessment                     jsonb       NOT NULL,
  factors                        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  caps                           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  explanation                    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  caveats                        jsonb       NOT NULL DEFAULT '[]'::jsonb,

  content_hash                   text        NOT NULL,
  -- When Inkora computed this assessment. Distinct from ingested_at.
  calculated_at                  timestamptz NOT NULL,
  ingested_at                    timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- INDEXES
--
-- Only the access paths the Opportunity Engine actually uses (docs/DATABASE.md
-- §12): chronological assessment history for one listing, and the same narrowed
-- to one marketplace × supplier pair. The pair index is partial because rows
-- with no candidate legitimately carry a NULL supplier_product_id.
-- =============================================================================

CREATE INDEX idx_opportunity_observations_product_calculated
  ON opportunity_observations (marketplace_product_id, calculated_at DESC);

CREATE INDEX idx_opportunity_observations_pair_calculated
  ON opportunity_observations (marketplace_product_id, supplier_product_id, calculated_at DESC)
  WHERE supplier_product_id IS NOT NULL;

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- Same posture as the rest of the intelligence layer (docs/DATABASE.md §11):
-- RLS is enabled with NO policies, so the anon and authenticated roles are
-- denied everything by default. These are server-owned tables; the browser
-- reaches them only through the API routes, which use the service role key.
-- =============================================================================

ALTER TABLE opportunity_observations ENABLE ROW LEVEL SECURITY;

-- No policies are defined: with RLS enabled and no matching policy, the anon
-- and authenticated roles are denied all access to this table by default.

-- =============================================================================
-- COMMENTS — schema self-documentation in the database itself.
-- =============================================================================

COMMENT ON TABLE  opportunity_observations                     IS 'An Opportunity Engine assessment stored as history. Attributes score, confidence and full reasoning to an engine version; never a prediction of sales.';
COMMENT ON COLUMN opportunity_observations.assessment          IS 'The complete OpportunityAssessment document: all five components, factors, caps, explanation and caveats.';
COMMENT ON COLUMN opportunity_observations.supplier_product_id IS 'NULL when the matcher surfaced no candidate. The assessment is still complete and explainable in that case.';
COMMENT ON COLUMN opportunity_observations.competition_query   IS 'The search query the competition figures belong to. A result count without its query is not a comparable number.';
COMMENT ON COLUMN opportunity_observations.confidence          IS 'Evidence confidence, computed independently from the score. Same 0-100 scale, never derived from the score.';
COMMENT ON COLUMN opportunity_observations.calculated_at       IS 'When Inkora computed this assessment. Distinct from ingested_at.';
COMMENT ON COLUMN opportunity_observations.ingested_at         IS 'When the row was inserted into the database. Distinct from calculated_at.';

