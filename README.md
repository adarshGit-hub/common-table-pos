# Common Table POS prototype

See [ROADMAP.md](ROADMAP.md) for the target architecture, delivery stages, and pilot acceptance checklist.
See [USER_GUIDE.md](USER_GUIDE.md) for the tested cashier and manager workflows.

A first vertical slice for an Indian mithai-house/QSR counter: touch-first order entry, dine-in tables, takeaway, item modifiers, kitchen display, demo tender capture, offline order outbox, and an 80 mm ESC/POS mock printer. The fictional Indore Mithai House catalogue contains 43 vegetarian training items across breakfast, chaat, North Indian food, thalis, sweets, namkeen, cookies, and beverages.

The catalogue is inspired by publicly listed Apna Sweets offerings and categories. Names and prices in the prototype are illustrative, some prices are estimates, and this is not an Apna Sweets account or a verified copy of its current menu. Confirm actual item, portion, price, tax, and outlet details before using it commercially.

Reference sources: [Apna Sweets official website](https://www.apnasweets.com/) and [a public Indore menu listing](https://indiarestros.com/r/apna-sweets-indore-city-jhec8rx687), which reports a 375-item menu last updated 14 October 2026. The demo includes only a 43-item subset and does not reuse the listing's descriptions or images.

## Requirements

- Node.js 22 or newer and npm 10 or newer
- For tablets on a local network, serve the production app over HTTPS. Browsers require a secure context for service workers outside `localhost`; development on the same machine can use `localhost`.

## Start in development

```sh
npm install
cp .env.example .env # optional for the local demo; use POS_* values for a real outlet
npm run dev
```

Vite serves the web client on port 5173 and proxies API/WebSocket traffic to the edge server's `PORT` (3001 by default). Set `POS_API_PROXY` when the edge runs at a different address. From the server workspace, the edge server creates `apps/server/.data/common-table.db` in SQLite WAL mode and starts its mock ESC/POS TCP listener on `127.0.0.1:9100`.

## Restaurant features on the cashier laptop

A terminal without a `POS_TERMINAL_KEY` runs in **standalone mode**: managers set up tables, menu and outlet details on the laptop itself. Once paired with the cloud, those setup screens become read-only and the cloud portal owns them; orders, payments and reports work the same either way. `GET /api/context` reports the current `setupMode`.

- **Floor and tables.** The Floor page shows every table as free, occupied, ready to serve or bill printed, with guests, running total and time seated. Tap a table to start or open its order, print a pre-payment bill, move the order to a free table, or merge two tables (merge is standalone-only). Managers add areas and numbered tables on the Tables page; removed tables with history are retired, not deleted.
- **Billing.** Bills are priced by one shared engine (`packages/contracts/src/pricing.ts`) on both the till and the server: items, item and whole-bill discounts (with a reason; cashiers are capped at a configurable share, default 10%), an optional dine-in service charge the guest can decline, GST split into CGST and SGST per rate, and rounding to the nearest rupee. Receipts print `TAX INVOICE` with GSTIN, taxable value, CGST/SGST per rate with HSN/SAC (default `996331`) and round-off. Orders opened before this engine keep their original totals (`pricing_version` 1). Check GST rates and invoice wording with your accountant; e-invoicing is not implemented.
- **Split bills.** A saved order can be split equally or by item between up to 10 guests; it stays one invoice with one tender per guest and a printed share slip each.
- **Customers and tokens.** An optional phone and name link an order to a returning customer (visits, last visit, total spend). Takeaway orders get a token number that restarts each business day, printed large on the kitchen ticket and receipt. Receipts mask all but the last four phone digits.
- **Menu and settings.** Managers edit items, prices, GST rate, HSN/SAC, kitchen station and options on the Menu page; cashiers can mark items sold out from the till. The Settings page holds the discount limit, service charge, quick kitchen notes and receipt details.
- **Reports.** Daily reports add discounts, service charge, round-off, CGST/SGST and a per-table and per-area section, each with CSV export.

Tests run on Node 22 (`npm test`); Node 26 has crashed natively in this suite.

## Supabase schema and local Auth

The tracked `supabase/migrations` directory includes the migrations already applied to the dedicated `common-table-pos` project, followed by the cloud order, payment, shift, cash movement, and audit projections. The local Supabase Auth Site URL is `http://localhost:5173`, matching Vite; it is separate from the hosted project's Auth settings. For a local Supabase stack, install Docker and run `npx supabase start` followed by `npx supabase db reset`. The local stack is configured not to load sample business records by default.

For hosted sign-up links, configure Supabase **Authentication → URL Configuration** with Site URL `https://common-table-pos.vercel.app` and allow `https://common-table-pos.vercel.app/admin`. The Confirm signup email should link to `{{ .ConfirmationURL }}`, which carries the redirect requested by the manager app. If a custom template constructs a callback URL manually, use `{{ .RedirectTo }}` instead of `{{ .SiteURL }}` for its redirect target. Vercel preview deployments intentionally have no production Supabase credentials.

## Install on a cashier laptop

Use Node.js 22 or newer. In the Common Table manager portal at `/admin`, enroll this laptop as a terminal and copy its one-time edge configuration. On the laptop, install dependencies, keep the outlet database and private configuration on its local disk, then build and start the production server:

```sh
npm ci
cp .env.example .env
# Replace the placeholder values with the one-time terminal configuration.
# Do not append duplicate keys; set POS_DATABASE_PATH to a durable local path.
npm run build
npm start
```

The copied configuration includes the browser-safe Supabase URL/publishable key, outlet and terminal IDs, a terminal sync key, and a random session-signing secret. Keep `.env` private; do not commit it or put the terminal key or session secret in a `VITE_*` variable. Set `POS_DATABASE_PATH` to a durable local path and configure the selected printer before service. `npm start` forces production mode and fails closed if required outlet configuration is missing. Open `http://localhost:3001/admin`, sign in while online, then open the cashier POS. After that first sign-in, the local session and outlet database work without internet; records sync when the connection returns. The session expires after 30 days without local use or on explicit sign-out. An explicit online denial of outlet access clears the local session; a network failure does not. `npm run dev` is for development only and uses a local owner shortcut. The default tax rate is demo data, not a tax configuration for a real outlet.

On a Linux desktop with a running systemd user session, the helper can build the app and install it as a per-user service:

```sh
./scripts/install-cashier-service.sh
```

It requires a complete outlet configuration, including an enrolled terminal sync key, and stores the SQLite database under `~/.local/share/common-table-pos/`. It starts at desktop login, restarts after a process failure, and checks `/api/ready` before reporting success. Service controls are `systemctl --user status|restart|stop common-table-pos.service`; follow logs with `journalctl --user -u common-table-pos.service -f`. To remove the service, run `systemctl --user disable --now common-table-pos.service` and remove `~/.config/systemd/user/common-table-pos.service`. Windows and macOS cashier setups can use the manual `npm start` steps above.

When `apps/web/dist` exists, Express serves the client and API on port 3001. Order, void, payment, and shift audit records use the signed-in staff user's ID.

The server adds an `x-request-id` response header and emits one JSON request log per HTTP request. `GET /api/health` is the liveness endpoint; `GET /api/ready` checks required outlet configuration and SQLite integrity; `GET /api/context` returns the configured outlet identity needed by the POS UI. Protected API routes require a staff session. Sign in through `/admin` on the same outlet edge origin; Supabase verifies the user and outlet membership, then the edge sets a signed `HttpOnly` cookie. Local activity renews this cookie on the laptop, so an active cashier session survives WAN loss and edge/browser restarts without calling Supabase. The cookie expires after 30 days without local use and is cleared on explicit sign-out. If an account is revoked while that laptop is offline, the revocation can only take effect after reconnection. Owner/manager, cashier, kitchen, and viewer roles have separate route permissions. Kitchen API and WebSocket snapshots omit order and item prices. An owner or manager can download `GET /api/support/diagnostics.json` from the outlet edge for a support bundle containing database checks, order-state counts, sync queue health, printer mode, and runtime version. The export omits order/customer records, auth tokens, and database paths.

In production, the edge creates one integrity-checked SQLite backup per UTC day at startup (and checks hourly), keeping seven days by default. Backups go to `POS_BACKUP_DIR`, or to a `backups/` folder beside `POS_DATABASE_PATH`. Set `POS_AUTO_BACKUP=false` to disable automatic snapshots or `POS_AUTO_BACKUP_RETENTION_DAYS` to choose 1–365 days. Backups on the cashier laptop protect against application-level database problems, not loss or damage of that laptop; set `POS_BACKUP_DIR` to an encrypted external drive for a separate copy. To create an additional SQLite-consistent backup while the edge server is running, build first and run `npm --workspace @common-table/server run backup`. Set `POS_BACKUP_PATH` to choose a one-off destination. Verify that the backup log reports `integrity: "ok"`. To restore, stop the edge service and run:

```sh
POS_RESTORE_SOURCE=/path/to/verified-backup.db \
POS_RESTORE_PATH=/path/to/common-table.db \
npm --workspace @common-table/server run restore
```

The restore command checks SQLite integrity, foreign keys, and the configured tenant/outlet before replacement. If the destination exists, it creates and verifies a `.pre-restore-<timestamp>.db` safety copy. Confirm `database.restore.completed` and `integrity: "ok"`, then start the edge and check `/api/ready` before allowing service.

## Vercel deployment

The root `vercel.json` builds the monorepo and publishes `apps/web/dist`. It hosts the frontend and `/admin` manager onboarding route, but does not deploy the local Express edge server: Vercel does not provide this prototype's durable SQLite WAL database or raw TCP printer socket. The Supabase URL and publishable key are browser-safe and configured on the Vercel production environment only. Do not add a service-role/secret key to a `VITE_*` variable. Orders from the hosted frontend remain in that browser's IndexedDB outbox unless connected to the outlet edge; they are not cloud-synced or shared with other devices. Payments and live KDS synchronization require the edge API. Use `npm run dev` or `npm run build && npm start` for the complete local prototype.

## Prototype boundaries

- The Indore menu and tax remain training data. Outlet identity is configurable through environment settings, and paired edges atomically refresh outlet name, timezone, currency, tax, receipt name/address/phone/GSTIN/footer, and menu together from Supabase; the last accepted snapshot is persisted in SQLite and orders retain their original currency and tax snapshot. The `/admin` route supports tenant/outlet setup, cloud menu administration, staff invitations, and terminal enrollment/revocation. Its one-time terminal configuration includes the browser-safe Supabase URL/key, outlet/terminal identifiers, a local session-signing secret, and the terminal sync key; keep the copied configuration in the outlet server's private `.env`. Once that edge starts, its terminal-authenticated menu pull confirms the key and updates the portal's `Last seen` status (refreshed every 15 seconds). Staff invite links are returned for the manager to share manually; no staff invitation email is sent. Local edge sessions and role-based API permissions are implemented and covered by the mock-auth integration test; a real second-user invite and an on-site terminal install still need pilot verification.
- Demo cash/UPI/card tenders are records only. No payment provider is called.
- Orders made while disconnected are stored in the browser's IndexedDB outbox and retried with the same command ID, preventing duplicate orders on server retries. Browser offline storage is per device/browser profile. Use the app once while connected before relying on the cached shell; across devices on a LAN, deploy with HTTPS.
- SQLite is the outlet edge database. A terminal-authenticated pull refreshes the managed outlet menu into SQLite as an atomic snapshot; menu versions use ETags, and order acceptance continues from the local copy during WAN loss. A durable local outbox syncs append-only business events to Supabase; a database trigger transactionally maintains tenant/outlet-scoped order, line, payment, shift, cash movement, and audit projections. The deployed `pos-reports` function reads those projections under the caller's manager RLS policy; its UI requires a deployed frontend and authenticated manager session. The edge's Daily reports page reads local SQLite for timezone-aware sales, tax, tender, item, void, and shift closeout totals and exports CSV; it is unavailable from the Vercel-only preview. Offline menu editing and merge-conflict resolution are not implemented.
- The printer formats 80 mm ESC/POS-compatible KOTs and receipts, including configured receipt identity and footer. Development defaults to a local mock TCP printer; production defaults to printing disabled. A configurable `network` mode sends raw TCP to a LAN printer (`POS_PRINTER_HOST`, `POS_PRINTER_PORT`, default 9100). This is a generic adapter, not a verified vendor driver: validate paper width, character encoding, cutter/drawer commands, and delivery behavior on the selected hardware before pilot use. The send callback only confirms the OS accepted the bytes, not that paper physically printed.

## Main routes

- Public: `GET /api/health`, `/api/ready`, `/api/context`. Staff session: `GET/POST/DELETE /api/auth/session`.
- Protected: `/api/menu`, `/api/orders`, `/api/kitchen`, `/api/floor-plan`, `/api/sync/status`, and report routes; permissions vary by staff role. The floor-plan endpoint reads the outlet's synced SQLite areas/tables/stations and marks tables occupied while an order is active.
- `GET /api/reports/daily`, `/api/reports/daily.csv` (outlet-local business date; local SQLite data)
- `POST /api/orders`, `POST /api/orders/:orderId/lines`, `POST /api/orders/:orderId/lines/:lineId/void`, `POST /api/orders/:orderId/void`
- `PATCH /api/orders/:orderId/status`, `/api/orders/:orderId/stations/:station/status`
- `POST /api/orders/:orderId/payment`, `/api/printer/test`
- WebSocket `/socket` provides an initial kitchen snapshot and order updates
