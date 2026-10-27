// Customer lookup and local menu editing (standalone terminals) for the cashier service.
import type { Express, RequestHandler } from 'express';
import type { CustomerSummary } from '@common-table/contracts';
import { createId, db, DEMO_OUTLET, DEMO_TENANT, enqueueSyncEvent, runLocalCommand } from '../database.js';
import { setupMode } from '../config.js';
import { currentStaff, requireRoles } from '../auth.js';
import { audit, fail, normalizeCustomer, orderById, routeParam, upsertCustomer } from '../core.js';
import { publish } from '../realtime.js';

const managers = requireRoles('owner', 'manager');
const floorStaff = requireRoles('owner', 'manager', 'cashier');
const standaloneOnly: RequestHandler = (_req, res, next) => {
  if (setupMode() === 'cloud') { fail(res, 409, 'The menu is managed in the cloud portal for this outlet.'); return; }
  next();
};

interface ItemFields { name?: string; category?: string; priceMinor?: number; kitchenStation?: string; vegetarian?: boolean;
  taxRateBps?: number | null; taxCode?: string | null; emoji?: string; color?: string; tag?: string | null; available?: boolean }

const clean = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.trim().length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;

/** Validates item fields; `required` demands everything a new item needs. Returns fields or an error message. */
function itemFields(body: Record<string, unknown>, required: boolean): ItemFields | string {
  const fields: ItemFields = {};
  const has = (key: string) => body[key] !== undefined;
  if (required || has('name')) { const name = clean(body.name, 120); if (!name) return 'Enter an item name of up to 120 characters.'; fields.name = name; }
  if (required || has('category')) { const category = clean(body.category, 80); if (!category) return 'Enter a category of up to 80 characters.'; fields.category = category; }
  if (required || has('priceMinor')) {
    const price = Number(body.priceMinor);
    if (!Number.isSafeInteger(price) || price < 0 || price > 100_000_000) return 'Enter a valid price.';
    fields.priceMinor = price;
  }
  if (required || has('kitchenStation')) { const station = clean(body.kitchenStation, 80); if (!station) return 'Choose a kitchen station.'; fields.kitchenStation = station; }
  if (has('vegetarian')) { if (typeof body.vegetarian !== 'boolean') return 'Vegetarian must be true or false.'; fields.vegetarian = body.vegetarian; }
  if (has('available')) { if (typeof body.available !== 'boolean') return 'Availability must be true or false.'; fields.available = body.available; }
  if (has('taxRateBps')) {
    if (body.taxRateBps === null) fields.taxRateBps = null;
    else { const rate = Number(body.taxRateBps); if (!Number.isSafeInteger(rate) || rate < 0 || rate > 10000) return 'GST rate must be between 0% and 100%.'; fields.taxRateBps = rate; }
  }
  if (has('taxCode')) {
    if (body.taxCode === null || body.taxCode === '') fields.taxCode = null;
    else if (typeof body.taxCode !== 'string' || !/^[0-9]{4,8}$/.test(body.taxCode.trim())) return 'HSN/SAC code must be 4 to 8 digits.';
    else fields.taxCode = body.taxCode.trim();
  }
  if (has('emoji')) { if (typeof body.emoji !== 'string' || body.emoji.length > 32) return 'Choose a shorter icon.'; fields.emoji = body.emoji.trim() || '🍽️'; }
  if (has('color')) { if (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color)) return 'Colour must look like #f5ecd5.'; fields.color = body.color; }
  if (has('tag')) { fields.tag = body.tag === null || body.tag === '' ? null : clean(body.tag, 20) ?? null; }
  return fields;
}

function ensureStation(name: string) {
  const exists = db.prepare('SELECT 1 FROM kitchen_stations WHERE tenant_id=? AND outlet_id=? AND name=?').get(DEMO_TENANT, DEMO_OUTLET, name);
  if (exists) return;
  const next = Number((db.prepare('SELECT COALESCE(MAX(sort_order)+1,0) AS next FROM kitchen_stations WHERE tenant_id=? AND outlet_id=?').get(DEMO_TENANT, DEMO_OUTLET) as { next: number }).next);
  db.prepare('INSERT INTO kitchen_stations(id,tenant_id,outlet_id,name,sort_order,active) VALUES(?,?,?,?,?,1)').run(createId(), DEMO_TENANT, DEMO_OUTLET, name, next);
}

function menuEditorView() {
  const items = db.prepare(`SELECT id,name,category,price_minor AS priceMinor,emoji,color,tag,vegetarian,available,kitchen_station AS kitchenStation,
      tax_code AS taxCode,tax_rate_bps AS taxRateBps FROM menu_items WHERE tenant_id=? AND outlet_id=? AND archived=0 ORDER BY category,rowid`)
    .all(DEMO_TENANT, DEMO_OUTLET) as Array<Record<string, unknown>>;
  const modifiers = db.prepare(`SELECT id,menu_item_id AS menuItemId,group_name AS "group",name,price_delta_minor AS priceDeltaMinor FROM menu_modifiers
    WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order`).all(DEMO_TENANT, DEMO_OUTLET) as Array<Record<string, unknown>>;
  const stations = db.prepare('SELECT name FROM kitchen_stations WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order,name').all(DEMO_TENANT, DEMO_OUTLET) as Array<{ name: string }>;
  return {
    setupMode: setupMode(),
    items: items.map(item => ({ ...item, vegetarian: Boolean(item.vegetarian), available: Boolean(item.available),
      modifiers: modifiers.filter(modifier => modifier.menuItemId === item.id).map(({ menuItemId: _item, ...modifier }) => modifier) })),
    categories: [...new Set(items.map(item => String(item.category)))],
    stations: stations.map(station => station.name),
  };
}

export function customerSummary(phone: string): CustomerSummary | null {
  const customer = db.prepare('SELECT id,phone,name FROM customers WHERE tenant_id=? AND outlet_id=? AND phone=?').get(DEMO_TENANT, DEMO_OUTLET, phone) as
    { id: string; phone: string; name: string | null } | undefined;
  if (!customer) return null;
  const stats = db.prepare(`SELECT COUNT(*) AS visits,MAX(created_at) AS lastVisitAt,COALESCE(SUM(total_minor),0) AS spend FROM orders
    WHERE tenant_id=? AND outlet_id=? AND customer_id=? AND status='paid'`).get(DEMO_TENANT, DEMO_OUTLET, customer.id) as { visits: number; lastVisitAt: string | null; spend: number };
  return { ...customer, visitCount: Number(stats.visits), lastVisitAt: stats.lastVisitAt, totalSpendMinor: Number(stats.spend) };
}

export function registerMenuRoutes(app: Express) {
  app.get('/api/customers/lookup', floorStaff, (req, res) => {
    const input = normalizeCustomer({ phone: typeof req.query.phone === 'string' ? req.query.phone : '' });
    if (typeof input === 'string') return fail(res, 400, input);
    return res.json({ customer: customerSummary(input.phone) });
  });

  app.post('/api/orders/:orderId/customer', floorStaff, (req, res) => {
    const order = orderById(routeParam(req, 'orderId'));
    if (!order) return fail(res, 404, 'Order not found.');
    if (order.status === 'cancelled') return fail(res, 409, 'Cancelled orders cannot be changed.');
    const input = normalizeCustomer(req.body as { phone: string; name?: string });
    if (typeof input === 'string') return fail(res, 400, input);
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      const customerId = upsertCustomer(input, timestamp);
      db.prepare('UPDATE orders SET customer_id=?,updated_at=? WHERE id=?').run(customerId, timestamp, order.id);
      audit('order', order.id, 'order.customer_linked', null, { customerId }, currentStaff(res).userId);
      enqueueSyncEvent('order', order.id, 'order.customer_linked', { ...orderById(order.id)! }, timestamp);
    })();
    const after = orderById(order.id)!;
    publish('order.updated', after);
    return res.json(after);
  });

  app.get('/api/setup/menu', managers, (_req, res) => res.json(menuEditorView()));

  app.post('/api/setup/menu/items', managers, standaloneOnly, (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.commandId !== 'string' || body.commandId.length < 8) return fail(res, 400, 'A stable commandId is required.');
    const fields = itemFields(body, true);
    if (typeof fields === 'string') return fail(res, 400, fields);
    try {
      const { result, duplicate } = runLocalCommand(body.commandId, 'menu.item_create', fields, () => {
        const id = createId();
        ensureStation(fields.kitchenStation!);
        db.prepare(`INSERT INTO menu_items(id,tenant_id,outlet_id,name,category,price_minor,emoji,color,tag,vegetarian,available,kitchen_station,tax_code,tax_rate_bps,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, DEMO_TENANT, DEMO_OUTLET, fields.name, fields.category, fields.priceMinor, fields.emoji ?? '🍽️',
          fields.color ?? '#f3ece0', fields.tag ?? null, fields.vegetarian === false ? 0 : 1, fields.available === false ? 0 : 1, fields.kitchenStation,
          fields.taxCode ?? null, fields.taxRateBps ?? null, new Date().toISOString());
        audit('setup', id, 'menu.item_created', null, { ...fields }, currentStaff(res).userId);
        return { id };
      });
      publish('floor.updated', { outletId: DEMO_OUTLET });
      return res.status(duplicate ? 200 : 201).json({ ...result, menu: menuEditorView() });
    } catch (error) { return fail(res, 409, error instanceof Error ? error.message : 'Could not add the item.'); }
  });

  app.patch('/api/setup/menu/items/:itemId', managers, standaloneOnly, (req, res) => {
    const body = req.body as Record<string, unknown>; const itemId = routeParam(req, 'itemId');
    const fields = itemFields(body, false);
    if (typeof fields === 'string') return fail(res, 400, fields);
    const item = db.prepare('SELECT id FROM menu_items WHERE tenant_id=? AND outlet_id=? AND id=? AND archived=0').get(DEMO_TENANT, DEMO_OUTLET, itemId);
    if (!item) return fail(res, 404, 'Menu item not found.');
    const columns: Record<keyof ItemFields, string> = { name: 'name', category: 'category', priceMinor: 'price_minor', kitchenStation: 'kitchen_station',
      vegetarian: 'vegetarian', taxRateBps: 'tax_rate_bps', taxCode: 'tax_code', emoji: 'emoji', color: 'color', tag: 'tag', available: 'available' };
    const entries = Object.entries(fields) as Array<[keyof ItemFields, unknown]>;
    if (!entries.length) return res.json(menuEditorView());
    db.transaction(() => {
      if (fields.kitchenStation) ensureStation(fields.kitchenStation);
      // Price edits apply to new orders only; existing order lines keep their price snapshot.
      db.prepare(`UPDATE menu_items SET ${entries.map(([key]) => `${columns[key]}=?`).join(',')},version=version+1,updated_at=? WHERE id=?`)
        .run(...entries.map(([, value]) => typeof value === 'boolean' ? (value ? 1 : 0) : value), new Date().toISOString(), itemId);
      audit('setup', itemId, 'menu.item_updated', null, { ...fields }, currentStaff(res).userId);
    })();
    publish('floor.updated', { outletId: DEMO_OUTLET });
    return res.json(menuEditorView());
  });

  app.post('/api/setup/menu/items/:itemId/remove', managers, standaloneOnly, (req, res) => {
    const itemId = routeParam(req, 'itemId');
    const item = db.prepare('SELECT name FROM menu_items WHERE tenant_id=? AND outlet_id=? AND id=? AND archived=0').get(DEMO_TENANT, DEMO_OUTLET, itemId) as { name: string } | undefined;
    if (!item) return fail(res, 404, 'Menu item not found.');
    const sold = Boolean(db.prepare('SELECT 1 FROM order_lines WHERE menu_item_id=? LIMIT 1').get(itemId))
      || Boolean(db.prepare('SELECT 1 FROM edge_inventory_recipes WHERE menu_item_id=? LIMIT 1').get(itemId));
    db.transaction(() => {
      // Items with sales history stay in the database (orders reference them) but leave the menu.
      if (sold) db.prepare('UPDATE menu_items SET archived=1,available=0,updated_at=? WHERE id=?').run(new Date().toISOString(), itemId);
      else { db.prepare('DELETE FROM menu_modifiers WHERE menu_item_id=?').run(itemId); db.prepare('DELETE FROM menu_items WHERE id=?').run(itemId); }
      audit('setup', itemId, 'menu.item_removed', null, { name: item.name, kept: sold }, currentStaff(res).userId);
    })();
    publish('floor.updated', { outletId: DEMO_OUTLET });
    return res.json(menuEditorView());
  });

  app.put('/api/setup/menu/items/:itemId/modifiers', managers, standaloneOnly, (req, res) => {
    const itemId = routeParam(req, 'itemId');
    const modifiers = (req.body as { modifiers?: unknown }).modifiers;
    if (!Array.isArray(modifiers) || modifiers.length > 32) return fail(res, 400, 'Send up to 32 modifiers.');
    const parsed = modifiers.map(value => {
      const row = value as Record<string, unknown>;
      const group = clean(row.group, 80); const name = clean(row.name, 120); const price = Number(row.priceDeltaMinor ?? 0);
      return group && name && Number.isSafeInteger(price) && price >= 0 && price <= 10_000_000 ? { group, name, priceDeltaMinor: price } : undefined;
    });
    if (parsed.some(row => !row)) return fail(res, 400, 'Each modifier needs a group, a name and a non-negative price.');
    if (!db.prepare('SELECT 1 FROM menu_items WHERE tenant_id=? AND outlet_id=? AND id=? AND archived=0').get(DEMO_TENANT, DEMO_OUTLET, itemId)) return fail(res, 404, 'Menu item not found.');
    db.transaction(() => {
      // Retire the old options; order lines keep their own modifier snapshot.
      db.prepare('UPDATE menu_modifiers SET active=0 WHERE tenant_id=? AND outlet_id=? AND menu_item_id=?').run(DEMO_TENANT, DEMO_OUTLET, itemId);
      const insert = db.prepare('INSERT INTO menu_modifiers(id,tenant_id,outlet_id,menu_item_id,group_name,name,price_delta_minor,active,sort_order) VALUES(?,?,?,?,?,?,?,1,?)');
      parsed.forEach((row, index) => insert.run(createId(), DEMO_TENANT, DEMO_OUTLET, itemId, row!.group, row!.name, row!.priceDeltaMinor, index));
      audit('setup', itemId, 'menu.modifiers_replaced', null, { modifiers: parsed }, currentStaff(res).userId);
    })();
    publish('floor.updated', { outletId: DEMO_OUTLET });
    return res.json(menuEditorView());
  });

  // Cashiers mark an item sold out (or back in stock) from the till.
  app.post('/api/menu/items/:itemId/availability', floorStaff, standaloneOnly, (req, res) => {
    const available = (req.body as { available?: unknown }).available;
    if (typeof available !== 'boolean') return fail(res, 400, 'Say whether the item is available.');
    const itemId = routeParam(req, 'itemId');
    const result = db.prepare('UPDATE menu_items SET available=?,updated_at=? WHERE tenant_id=? AND outlet_id=? AND id=? AND archived=0')
      .run(available ? 1 : 0, new Date().toISOString(), DEMO_TENANT, DEMO_OUTLET, itemId);
    if (!result.changes) return fail(res, 404, 'Menu item not found.');
    audit('setup', itemId, available ? 'menu.item_back_in_stock' : 'menu.item_sold_out', null, {}, currentStaff(res).userId);
    publish('floor.updated', { outletId: DEMO_OUTLET });
    return res.json({ id: itemId, available });
  });
}
