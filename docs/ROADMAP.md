# Inkora — Roadmap

> **Status: Directional and deliberately conservative.**
> Future items are **not** current implementation requirements.

No speculative dates are assigned. **Sequencing** is what matters.

## Foundation — *current*

- Repository structure and governance.
- Authoritative documentation set (`/docs`).
- `.gitignore` protecting secrets and local artifacts.
- `.env.example` containing variable names only.
- Git initialization and a clean baseline commit.
- Deployment-readiness *conventions* (not a deployed application).

**Exit criterion:** the repository is safe, documented, and reviewable.

## V1 — MVP

One marketplace, one supplier, five screens.

- **Marketplace:** eBay. **Supplier:** CJdropshipping.
- **Screens:** Dashboard, Product Scanner, Seller Scanner, Product Detail,
  Watchlist.
- **Core intelligence:** marketplace discovery, supplier matching,
  Product Matcher, profitability, fee calculation, opportunity scoring,
  historical snapshots, watchlist monitoring.
- **Economics:** deterministic Fee Engine + Profit Engine; LLMs never do the
  money math.
- **Provenance:** OFFICIAL / OBSERVED / ESTIMATED enforced end-to-end.

**Exit criterion:** the eBay → CJ pipeline produces a defensible, explainable
Opportunity Score computed from real data with real history behind it.

### V1 validation gates (online-first)

Validate progressively, in this order — do not skip ahead:

1. Build health.
2. Deployment behavior (a benign health-check route, **not** feature code).
3. Supabase connectivity.
4. Environment configuration correctness.
5. eBay connectivity.
6. CJ connectivity.
7. Production-like failure handling (timeouts, rate limits, stale data).
8. Cross-marketplace matching: a real eBay listing resolving to ranked CJ
   candidates with honest confidences (validated by
   `scripts/live-matcher.mts`).

9. Economics: a real eBay listing → a matched CJ candidate resolving to a real
   CJ variant and a **real freight quote**, producing a landed cost, profit,
   and margin whose completeness and provenance are honest — including at
   least one case that lands `PARTIAL` or `UNAVAILABLE` rather than a
   fabricated figure (validated through `GET /api/products/economics`).

10. Persistence and history: a real eBay listing whose economics are **stored**
    and then read back through `GET /api/products/history`, including a
    repeated observation that deduplicates against the latest row (no duplicate
    insert for an unchanged observation) and a changed observation that inserts
    a new one. Verified with the service key server-only and no secret material
    in the browser bundle.

11. Opportunity scoring: a real eBay listing → a matched CJ candidate producing a
    deterministic, versioned assessment — a 0–100 score with its band, a
    **separate** evidence confidence, five components whose weights are published
    once in code, and every factor and cap that moved the result — including at
    least one case that lands `LOW` or is hard-capped rather than a flattering
    number, and one first evaluation that honestly reports no history (validated
    by `scripts/live-opportunity.mts` through `GET /api/products/opportunity`,
    whose `persistence.status` flips from `failed` to `ok` once the
    `opportunity_observations` migration of `docs/DATABASE.md` §1.3 is applied).

12. Opportunity scanning: three real, un-cherry-picked eBay queries each producing
    a bounded, ranked batch of assessments through `POST /api/scanner/scan` —
    including at least one listing the matcher cannot source (a verdict hard-capped
    at `LOW`, not an error), at least one economics `UNAVAILABLE` or `PARTIAL`
    outcome, and one manual-mode run containing an id that has scrolled out of the
    replayed window, which must be reported per item while the rest of the batch
    still produces verdicts (validated by `scripts/live-scanner.mts`).

We do not postpone integration validation until the end of the project, but we
also do not deploy unfinished feature code merely to satisfy this principle.

## V1.5 — potential expansion

- Amazon
- AliExpress (as the second supplier ecosystem)

**Only after** V1 architecture and core workflows are validated.

## V2 — potential

- Etsy
- TikTok Shop

## Later — potential commerce integrations

- Shopify
- WooCommerce

## Explicitly not on the roadmap

- Zendrop, Spocket, and other paid supplier platforms
  (see `docs/API_INTEGRATIONS.md` §5).
- Placeholder integrations for any excluded platform.

## Operating rules for this roadmap

- A future phase never justifies building its code today.
- Every implementation increment is **small, testable, reversible,
  documented**.
- New marketplaces/suppliers are added as new adapters behind the existing
  interfaces — never by branching core domain logic.
