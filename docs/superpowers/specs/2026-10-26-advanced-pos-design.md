# Advanced POS: tables, billing features, and cleanup

**Date:** 2026-10-26
**Status:** Approved

## Goal

Turn the local cashier POS into a day-to-day restaurant tool without depending on Supabase: manage tables locally, run the floor table by table, and bill with discounts, service charge, GST-ready receipts, customers and takeaway tokens. Clean up redundant browser caches and verify existing code health first.

## Ownership: standalone mode

`setupMode` is derived on the edge: `standalone` when `POS_TERMINAL_KEY` is not configured, `cloud` otherwise. It is returned by `GET /api/context`.

- In `standalone` mode, owners/managers edit areas, tables, menu and outlet settings locally.
- In `cloud` mode, setup endpoints return `409` ("Managed in the cloud portal") and setup screens are read-only. The cloud snapshot keeps replacing setup exactly as today.
- Orders, payments, table operations and reports behave the same in both modes.

## Phases

Each phase ends with a passing test suite and its own commit.

| # | Phase | Scope |
|---|---|---|
| 0 | Health check and split | Test + typecheck on Node 22 (the project's target; Node 26 crashes natively in one test). Review for real bugs, fix each with a regression test. Move routes out of `apps/server/src/index.ts` into `routes/*.ts` with no behaviour change. |
| 1 | Cache cleanup | Remove localStorage copies of menu, floor plan and outlet context, and direct cloud-menu reads from `App.tsx`. The local edge is the single source. Keep the service worker app-shell cache and the IndexedDB order outbox. |
| 2 | Tables | Local table management, live floor view, move / merge / split bill, table reports. |
| 3 | Discounts, service charge, settings | |
| 4 | GST-ready bills | |
| 5 | Customers, tokens, notes, local menu editing | |

## Conventions

- Additive SQLite migrations in the existing guarded `ALTER TABLE … ADD COLUMN` style; existing databases upgrade in place.
- Money stays in integer minor units (paise).
- Every write command carries a `commandId` and is idempotent; every sensitive action writes an audit event and enqueues sync events like existing commands.
- Tests use `node --test` end-to-end style against a disposable SQLite database.

## Phase 2: Tables

**Data.** `orders` gains nullable `table_id` (FK to `dining_tables`) and `bill_printed_at`. Migration backfills `table_id` by matching `table_label` to table names. `table_label` remains the name snapshot. A table or area with order history is soft-deleted (`active=0`); one without history is hard-deleted.

**Manage tables** (owner/manager, standalone only). Sidebar page **Tables**: add/rename/reorder/remove areas; bulk-add tables (area, prefix, number range, seats); edit a single table. A table with an open order cannot be removed. Endpoints under `/api/setup/areas` and `/api/setup/tables`.

**Live floor view.** Grid grouped by area. Each card shows status (Free, Occupied, Bill printed, Ready to serve when all its kitchen tickets are ready), guests vs seats, running total and time seated. Tapping a free table starts an order; tapping an occupied table opens it. Updates arrive over the existing WebSocket. **Print bill** prints a pre-payment bill and sets `bill_printed_at`.

**Table operations** (cashier and above, reason required, audited):
- **Move** an open order to a free table. Moving to an occupied table is rejected with a suggestion to merge.
- **Merge** table B's open order into table A's: lines and kitchen tickets move to A in one transaction; B ends `cancelled` with reason "Merged into A". Nothing is re-sent to the kitchen. If the cloud projection cannot handle lines moving between orders, merge is disabled in `cloud` mode with a clear message.
- **Split bill** equally into N parts or by items, using the existing multi-tender payment path with the tender limit raised from 3 to 10. One invoice; a share slip prints per guest.

**Table reports.** "Tables" tab in Daily reports: per table and per area for the business day — orders, guests, sales, average bill, average time seated, turns. CSV export.

## Phase 3: Discounts, service charge, settings

**Bill maths for new orders:** `items − discounts + service charge = taxable → tax → round-off → total`. Existing orders keep stored totals.

**Discounts.** Line or bill level, percent or fixed amount, reason required. Cashiers may discount up to a configurable limit (default 10% of the affected amount); larger discounts require an owner/manager session. Stored append-only in `order_discounts` (voidable, never edited). Shown on bill, receipt and reports.

**Service charge.** Off by default, dine-in only, percent configured in Settings, removable per bill by the cashier (Indian CCPA 2022 guidelines: not compulsory). Taxed at the outlet rate; shown as its own line.

**Settings page** (standalone only): outlet name, receipt address/phone/GSTIN/footer, cashier discount limit, service charge percent, quick-note chips. Stored in SQLite (`outlet_settings`), overriding `.env` defaults.

## Phase 4: GST-ready bills

- Items carry HSN/SAC code (default `996331`) and GST rate (existing per-item rate).
- Tax is computed per rate bucket on the invoice and split equally into CGST and SGST.
- Receipt shows tax table, GSTIN, invoice number/date, and round-off to the nearest rupee.
- Daily report and CSV add taxable value, CGST, SGST and round-off.
- Out of scope: e-invoicing (IRN), IGST, legal sign-off.

## Phase 5: Customers, tokens, notes, menu editing

- **Customers:** optional name + phone per order in a local `customers` table; phone lookup shows visit count, last visit and total spend. No marketing.
- **Tokens:** takeaway orders get a token number resetting per business day, printed large on KOT and receipt.
- **Notes:** order-level kitchen notes appear on KDS and KOT; quick-note chips from Settings.
- **Local menu editing** (owner/manager, standalone only): categories, items (name, price, category, station, veg, GST rate, HSN, emoji/colour, modifiers), sold-out toggle from the cashier screen. Items with sales history are hidden, not deleted.

## Out of scope

Manager PIN overrides, IGST/e-invoicing, syncing local setup edits to Supabase, loyalty/marketing, delivery aggregators.
