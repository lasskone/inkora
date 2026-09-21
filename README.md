# Inkora

**Cross-Marketplace E-Commerce Opportunity Intelligence Platform.**

Inkora answers: *What products are selling, where are they selling, how
competitive is the market, where can they be sourced, and which Marketplace ×
Supplier combination provides the strongest business opportunity?*

## MVP V1 scope

| Layer | V1 choice |
| --- | --- |
| Marketplace | **eBay** |
| Supplier / fulfillment | **CJdropshipping** |
| Database / backend | **Supabase (PostgreSQL)** |
| Source control | GitHub |
| Domain | [inkora.net](https://inkora.net) |

## Authoritative documentation

All project documentation lives in [`/docs`](./docs) and is the single source
of truth for AI-assisted development. **Read it before implementing anything.**

| Document | Role |
| --- | --- |
| [`docs/MVP_SPEC.md`](./docs/MVP_SPEC.md) | Authoritative MVP V1 product scope and boundaries. |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Architecture principles, adapters, core domain services, provenance. |
| [`docs/DATABASE.md`](./docs/DATABASE.md) | Supabase/PostgreSQL data model, entities, snapshots, RLS. |
| [`docs/API_INTEGRATIONS.md`](./docs/API_INTEGRATIONS.md) | eBay and CJdropshipping integration strategy and supplier policy. |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Phased roadmap and online-first validation strategy. |

## Repository status

**Foundation stage.** This repository currently contains governance and
documentation files only. No application code has been implemented yet —
see [`docs/ROADMAP.md`](./docs/ROADMAP.md).

## Environment

- Copy `.env.example` to a local `.env` (Git-ignored) and fill in real values.
- **Never commit real secrets.** Never expose server-only variables to
  frontend code, and never print secrets in logs.

## What is intentionally absent

- No application framework, build tooling, or dependencies have been chosen or
  installed. The Lead Architect decides the implementation stack after
  reviewing this foundation.
- No eBay/CJ integration code, no database migrations, and **no adapters for
  paid supplier platforms** (Zendrop, Spocket) — these are excluded by policy
  (see `docs/API_INTEGRATIONS.md`).
