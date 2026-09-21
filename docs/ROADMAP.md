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
