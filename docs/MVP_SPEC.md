# Inkora — MVP Specification (V1)

> **Status: Authoritative.** This document defines the MVP V1 product scope and
> its boundaries. Any deviation requires explicit approval from the Lead
> Architect.

## 1. What Inkora is

Inkora is a **Cross-Marketplace E-Commerce Opportunity Intelligence Platform**.

Its purpose is to answer, for any product category of interest:

1. What products are selling?
2. Where are they selling?
3. How competitive is the market?
4. Where can they be sourced?
5. Which **Marketplace × Supplier** combination provides the strongest
   business opportunity?

## 2. MVP V1 focus

MVP V1 intentionally narrows the platform to a single marketplace and a single
supplier ecosystem so the core intelligence pipeline can be validated
end-to-end before any expansion.

| Layer | V1 choice |
| --- | --- |
| Marketplace | **eBay** |
| Supplier / fulfillment | **CJdropshipping** |
| Database / backend | **Supabase (PostgreSQL)** |
| Domain | inkora.net |

## 3. Primary objective

**Find the best e-commerce opportunities, not merely display product data.**

Inkora is not a product catalogue or a scraping dashboard. Every screen exists
to surface, rank, and monitor *opportunity*. Raw marketplace data is an input;
the output the user cares about is a defensible ranking of where money can be
made.

## 4. The five primary MVP screens

1. **Dashboard** — prioritized opportunity overview, monitoring state, and
   entry points into the scanners.
2. **Product Scanner** — marketplace-side discovery of products and
   opportunities by keyword, category, filters, and modes.
3. **Seller Scanner** — seller/competitive-side analysis: seller saturation,
   growth, and behavior.
4. **Product Detail** — the deep view of one product: marketplace signals,
   provenance, supplier matches, economics, and opportunity score. *Delivered as
   a persisted-first read surface:* one canonical route carrying the replay query,
   a normal load that costs no upstream call, an explicit re-evaluation that
   re-proves the pairing, and per-section degradation to `unavailable`/`partial`
   rather than to a zero or an estimate (see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
   §18).
5. **Watchlist** — the monitored subset of products/opportunities the user
   wants tracked over time. *Delivered as Watchlist V1:* manual and bounded by
   design — one table keyed by stable provider identities, re-evaluation on
   demand, and no scheduler, alerts, or background worker
   (see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) §16).

### 4.1 Advanced capability lives *inside* these screens

Advanced capabilities should generally be implemented as **modes, filters,
panels, tabs, or supporting workflows** inside the five screens — **not** as
new top-level navigation pages.

Adding a new navigation page to host an advanced feature requires explicit
justification. This keeps the product learnable and the surface area small.

## 5. Major intelligence dimensions

The platform must reason across — and keep separable — the following
dimensions:

- **Demand** — how strongly the market wants the product.
- **Competition** — how crowded the listing/seller space is.
- **Profitability** — modeled net profit and margin after all known costs.
- **Sourcing** — availability and suitability of supply.
- **Seller saturation** — concentration of sellers in the niche.
- **Supplier availability** — whether a viable supplier exists with stock.
- **Shipping feasibility** — cost and speed of fulfillment to the target market.
- **Price behavior** — price level, stability, and movement over time.
- **Trend** — direction of demand/interest over time.
- **Opportunity quality** — the composite conclusion of the dimensions above.

## 6. MVP boundaries — explicitly out of scope for V1

V1 does **not** require implementation of the following marketplaces:

- Amazon
- Etsy
- TikTok Shop
- Shopify
- WooCommerce
- AliExpress

These belong to later phases (see [`docs/ROADMAP.md`](./ROADMAP.md)).

### 6.1 Paid supplier platforms are excluded

The following paid supplier platforms are **not part of the roadmap**:

- **Zendrop**
- **Spocket**

Do **not** create placeholder integrations, adapters, or configuration for
them. See the supplier policy in [`docs/API_INTEGRATIONS.md`](./API_INTEGRATIONS.md).

## 7. Data provenance (summary)

Every quantitative claim the UI makes must carry a provenance class. The full
definition lives in [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) → *Data
provenance*.

- **OFFICIAL** — returned directly by an official/authenticated first-party API.
- **OBSERVED** — legitimately observable marketplace data, not necessarily
  returned by the primary official API.
- **ESTIMATED** — calculated or modeled by Inkora.

Never fabricate precision. Never present an estimated value as official.

## 8. Non-functional expectations

- **Deterministic economics.** Fees, profit, and margin are computed by code,
  never invented by an LLM (see `docs/ARCHITECTURE.md` → *Fee Engine* /
  *Profit Engine*).
- **Defensible scoring.** The Opportunity Score is deterministic and
  versionable (see `docs/ARCHITECTURE.md` → *Opportunity Engine*).
- **Real history.** The platform retains snapshots so trends are measured, not
  guessed (see `docs/DATABASE.md` → *Snapshot / history strategy*).
- **Manual monitoring.** A watch records the *intent* to monitor an opportunity by
  stable provider identity and is re-evaluated on demand through the same
  deterministic pipeline that produced it — never automatically, and never with a
  score or economics figure of its own (see `docs/ARCHITECTURE.md` §16).
