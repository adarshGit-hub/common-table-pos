// Floor view, local table setup, and table operations (move, merge, print bill).
import type { Express, RequestHandler, Response } from 'express';
import type { FloorAreaView, FloorTableStatus, FloorView, OrderRecord } from '@common-table/contracts';
import { createId, db, DEMO_OUTLET, DEMO_TENANT, enqueueSyncEvent, runLocalCommand } from '../database.js';
import { EDGE_CONFIG, setupMode } from '../config.js';
import { currentStaff, requireRoles } from '../auth.js';
import { activeOrderAtTable, audit, fail, findTable, orderById, queuePrint, recalculateOrder, refreshOrderKitchenStatus, routeParam } from '../core.js';
import { formatBill } from '../printer.js';
import { publish } from '../realtime.js';
import { operationalSettings } from '../settings.js';

const ACTIVE = "('sent','preparing','ready')";
const managers = requireRoles('owner', 'manager');
const floorStaff = requireRoles('owner', 'manager', 'cashier');

/** Setup edits belong to this laptop only while it is not paired with the cloud portal. */
const standaloneOnly: RequestHandler = (_req, res, next) => {
  if (setupMode() === 'cloud') { fail(res, 409, 'Tables are managed in the cloud portal for this outlet.'); return; }
  next();
};

function label(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined;
}
function reason(value: unknown): string | undefined {
  const text = label(value, 120);
  return text && text.length >= 3 ? text : undefined;
}
function commandId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length >= 8 && value.length <= 160 ? value : undefined;
}
function capacity(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 50 ? Number(value) : undefined;
}
/** Runs a local command and maps validation errors to 409 so the client can show them. */
function respond<T>(res: Response, run: () => { result: T; duplicate: boolean }, status = 200) {
  try {
    const { result, duplicate } = run();
    publish('floor.updated', { outletId: DEMO_OUTLET });
    return res.status(duplicate ? 200 : status).json(result);
  } catch (error) {
    return fail(res, 409, error instanceof Error ? error.message : 'Could not apply this change.');
  }
}
function nameTaken(table: 'dining_areas' | 'dining_tables', name: string, exceptId = ''): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id=? AND outlet_id=? AND name=? COLLATE NOCASE AND id<>?`)
    .get(DEMO_TENANT, DEMO_OUTLET, name, exceptId));
}
function tableHasHistory(tableId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM orders WHERE tenant_id=? AND outlet_id=? AND table_id=? LIMIT 1').get(DEMO_TENANT, DEMO_OUTLET, tableId));
}
/** A removed record keeps its row for history but frees its name for reuse. */
function retiredName(name: string, id: string): string { return `${name} (removed ${id.slice(0, 6)})`.slice(0, 120); }

export function floorView(): FloorView {
  const areas = db.prepare('SELECT id,name,sort_order AS sortOrder FROM dining_areas WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order,name')
    .all(DEMO_TENANT, DEMO_OUTLET) as Array<{ id: string; name: string; sortOrder: number }>;
  const tables = db.prepare(`SELECT id,area_id AS areaId,name,capacity,sort_order AS sortOrder FROM dining_tables
    WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order,name`).all(DEMO_TENANT, DEMO_OUTLET) as
    Array<{ id: string; areaId: string; name: string; capacity: number; sortOrder: number }>;
  const orders = db.prepare(`SELECT id,table_id AS tableId,order_number AS orderNumber,guest_count AS guestCount,total_minor AS totalMinor,
      created_at AS createdAt,bill_printed_at AS billPrintedAt,status FROM orders
    WHERE tenant_id=? AND outlet_id=? AND table_id IS NOT NULL AND status IN ${ACTIVE}`).all(DEMO_TENANT, DEMO_OUTLET) as
    Array<{ id: string; tableId: string; orderNumber: string; guestCount: number; totalMinor: number; createdAt: string; billPrintedAt: string | null; status: string }>;
  const byTable = new Map(orders.map(order => [order.tableId, order]));
  const view: FloorAreaView[] = areas.map(area => ({
    ...area,
    tables: tables.filter(table => table.areaId === area.id).map(({ areaId: _area, ...table }) => {
      const order = byTable.get(table.id);
      const status: FloorTableStatus = !order ? 'free' : order.billPrintedAt ? 'bill_printed' : order.status === 'ready' ? 'ready' : 'occupied';
      return { ...table, status, order: order ? { id: order.id, orderNumber: order.orderNumber, guestCount: Number(order.guestCount),
        totalMinor: Number(order.totalMinor), createdAt: order.createdAt, billPrintedAt: order.billPrintedAt } : null };
    }),
  }));
  return { setupMode: setupMode(), currency: EDGE_CONFIG.currency, areas: view };
}

function activeOrder(res: Response, orderId: string): OrderRecord | undefined {
  const order = orderById(orderId);
  if (!order) { fail(res, 404, 'Order not found.'); return undefined; }
  if (!['sent', 'preparing', 'ready'].includes(order.status)) { fail(res, 409, 'Only open, unpaid orders can be changed.'); return undefined; }
  return order;
}

const TICKET_RANK: Record<string, number> = { new: 0, preparing: 1, ready: 2 };

export function registerTableRoutes(app: Express) {
  app.get('/api/floor', floorStaff, (_req, res) => res.json(floorView()));

  app.post('/api/setup/areas', managers, standaloneOnly, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const id = commandId(body.commandId); const name = label(body.name, 80);
    if (!id || !name) return fail(res, 400, 'Enter an area name of up to 80 characters.');
    return respond(res, () => runLocalCommand(id, 'area.create', { name }, () => {
      if (nameTaken('dining_areas', name)) throw new Error(`An area named ${name} already exists.`);
      const areaId = createId();
      const sortOrder = Number((db.prepare('SELECT COALESCE(MAX(sort_order)+1,0) AS next FROM dining_areas WHERE tenant_id=? AND outlet_id=?')
        .get(DEMO_TENANT, DEMO_OUTLET) as { next: number }).next);
      db.prepare('INSERT INTO dining_areas(id,tenant_id,outlet_id,name,sort_order,active) VALUES(?,?,?,?,?,1)').run(areaId, DEMO_TENANT, DEMO_OUTLET, name, sortOrder);
      audit('setup', areaId, 'area.created', null, { name }, currentStaff(res).userId);
      return { id: areaId, name, sortOrder };
    }), 201);
  });

  app.patch('/api/setup/areas/:areaId', managers, standaloneOnly, (req, res) => {
    const body = req.body as Record<string, unknown>; const areaId = routeParam(req, 'areaId');
    const id = commandId(body.commandId);
    const name = body.name === undefined ? undefined : label(body.name, 80);
    const sortOrder = body.sortOrder === undefined ? undefined : Number(body.sortOrder);
    if (!id || (body.name !== undefined && !name) || (sortOrder !== undefined && (!Number.isSafeInteger(sortOrder) || sortOrder < 0)))
      return fail(res, 400, 'Enter a valid area name or position.');
    return respond(res, () => runLocalCommand(id, 'area.update', { areaId, name, sortOrder }, () => {
      const area = db.prepare('SELECT id,name FROM dining_areas WHERE tenant_id=? AND outlet_id=? AND id=? AND active=1').get(DEMO_TENANT, DEMO_OUTLET, areaId) as { id: string; name: string } | undefined;
      if (!area) throw new Error('Area not found.');
      if (name && nameTaken('dining_areas', name, areaId)) throw new Error(`An area named ${name} already exists.`);
      db.prepare('UPDATE dining_areas SET name=COALESCE(?,name),sort_order=COALESCE(?,sort_order) WHERE id=?').run(name ?? null, sortOrder ?? null, areaId);
      audit('setup', areaId, 'area.updated', null, { from: area.name, name, sortOrder }, currentStaff(res).userId);
      return { id: areaId };
    }));
  });

  app.post('/api/setup/areas/:areaId/remove', managers, standaloneOnly, (req, res) => {
    const id = commandId((req.body as Record<string, unknown>).commandId); const areaId = routeParam(req, 'areaId');
    if (!id) return fail(res, 400, 'A stable commandId is required.');
    return respond(res, () => runLocalCommand(id, 'area.remove', { areaId }, () => {
      const area = db.prepare('SELECT id,name FROM dining_areas WHERE tenant_id=? AND outlet_id=? AND id=? AND active=1').get(DEMO_TENANT, DEMO_OUTLET, areaId) as { id: string; name: string } | undefined;
      if (!area) throw new Error('Area not found.');
      const tables = db.prepare('SELECT id,name FROM dining_tables WHERE tenant_id=? AND outlet_id=? AND area_id=? AND active=1').all(DEMO_TENANT, DEMO_OUTLET, areaId) as Array<{ id: string; name: string }>;
      const busy = tables.find(table => activeOrderAtTable(table.id));
      if (busy) throw new Error(`${busy.name} has an open order. Settle or move it before removing ${area.name}.`);
      const history = tables.some(table => tableHasHistory(table.id))
        || Boolean(db.prepare('SELECT 1 FROM dining_tables WHERE tenant_id=? AND outlet_id=? AND area_id=? AND active=0 LIMIT 1').get(DEMO_TENANT, DEMO_OUTLET, areaId));
      if (history) {
        for (const table of tables) db.prepare('UPDATE dining_tables SET active=0,name=? WHERE id=?').run(retiredName(table.name, table.id), table.id);
        db.prepare('UPDATE dining_areas SET active=0,name=? WHERE id=?').run(retiredName(area.name, area.id), areaId);
      } else {
        db.prepare('DELETE FROM dining_tables WHERE tenant_id=? AND outlet_id=? AND area_id=?').run(DEMO_TENANT, DEMO_OUTLET, areaId);
        db.prepare('DELETE FROM dining_areas WHERE id=?').run(areaId);
      }
      audit('setup', areaId, 'area.removed', null, { name: area.name, tableCount: tables.length, kept: history }, currentStaff(res).userId);
      return { id: areaId, removed: true };
    }));
  });

  app.post('/api/setup/tables', managers, standaloneOnly, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const id = commandId(body.commandId); const areaId = typeof body.areaId === 'string' ? body.areaId : '';
    const seats = capacity(body.capacity);
    // Either one named table, or a numbered range such as prefix "T", from 1 to 12.
    const single = body.name === undefined ? undefined : label(body.name, 40);
    const prefix = body.prefix === undefined ? '' : label(body.prefix, 20);
    const from = Number(body.from); const to = Number(body.to);
    const ranged = body.name === undefined && prefix !== undefined && Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from && to - from < 100;
    if (!id || !areaId || !seats || (!single && !ranged)) return fail(res, 400, 'Choose an area, seats (1-50), and a table name or number range of up to 100 tables.');
    const width = String(to).length;
    const names = single ? [single] : Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${prefix && !prefix.endsWith(' ') ? ' ' : ''}${String(from + index).padStart(Math.max(2, width), '0')}`.trim());
    if (names.some(name => name.length > 40)) return fail(res, 400, 'Table names must be 40 characters or fewer.');
    return respond(res, () => runLocalCommand(id, 'table.create', { areaId, names, seats }, () => {
      if (!db.prepare('SELECT 1 FROM dining_areas WHERE tenant_id=? AND outlet_id=? AND id=? AND active=1').get(DEMO_TENANT, DEMO_OUTLET, areaId)) throw new Error('Area not found.');
      const clash = names.find(name => nameTaken('dining_tables', name));
      if (clash) throw new Error(`A table named ${clash} already exists.`);
      let sortOrder = Number((db.prepare('SELECT COALESCE(MAX(sort_order)+1,0) AS next FROM dining_tables WHERE tenant_id=? AND outlet_id=? AND area_id=?')
        .get(DEMO_TENANT, DEMO_OUTLET, areaId) as { next: number }).next);
      const insert = db.prepare('INSERT INTO dining_tables(id,tenant_id,outlet_id,area_id,name,capacity,sort_order,active) VALUES(?,?,?,?,?,?,?,1)');
      const created = names.map(name => { const tableId = createId(); insert.run(tableId, DEMO_TENANT, DEMO_OUTLET, areaId, name, seats, sortOrder++); return { id: tableId, name }; });
      audit('setup', areaId, 'tables.created', null, { names, capacity: seats }, currentStaff(res).userId);
      return { tables: created };
    }), 201);
  });

  app.patch('/api/setup/tables/:tableId', managers, standaloneOnly, (req, res) => {
    const body = req.body as Record<string, unknown>; const tableId = routeParam(req, 'tableId');
    const id = commandId(body.commandId);
    const name = body.name === undefined ? undefined : label(body.name, 40);
    const seats = body.capacity === undefined ? undefined : capacity(body.capacity);
    const areaId = body.areaId === undefined ? undefined : typeof body.areaId === 'string' ? body.areaId : '';
    const sortOrder = body.sortOrder === undefined ? undefined : Number(body.sortOrder);
    if (!id || (body.name !== undefined && !name) || (body.capacity !== undefined && !seats) || areaId === ''
      || (sortOrder !== undefined && (!Number.isSafeInteger(sortOrder) || sortOrder < 0))) return fail(res, 400, 'Enter a valid table name, seats, area or position.');
    return respond(res, () => runLocalCommand(id, 'table.update', { tableId, name, seats, areaId, sortOrder }, () => {
      const table = findTable(tableId);
      if (!table) throw new Error('Table not found.');
      if (name && nameTaken('dining_tables', name, tableId)) throw new Error(`A table named ${name} already exists.`);
      if (areaId && !db.prepare('SELECT 1 FROM dining_areas WHERE tenant_id=? AND outlet_id=? AND id=? AND active=1').get(DEMO_TENANT, DEMO_OUTLET, areaId)) throw new Error('Area not found.');
      db.prepare('UPDATE dining_tables SET name=COALESCE(?,name),capacity=COALESCE(?,capacity),area_id=COALESCE(?,area_id),sort_order=COALESCE(?,sort_order) WHERE id=?')
        .run(name ?? null, seats ?? null, areaId ?? null, sortOrder ?? null, tableId);
      // Open orders show the table's current name; paid history keeps its original label.
      if (name) db.prepare(`UPDATE orders SET table_label=? WHERE tenant_id=? AND outlet_id=? AND table_id=? AND status IN ${ACTIVE}`).run(name, DEMO_TENANT, DEMO_OUTLET, tableId);
      audit('setup', tableId, 'table.updated', null, { from: table.name, name, capacity: seats, areaId, sortOrder }, currentStaff(res).userId);
      return { id: tableId };
    }));
  });

  app.post('/api/setup/tables/:tableId/remove', managers, standaloneOnly, (req, res) => {
    const id = commandId((req.body as Record<string, unknown>).commandId); const tableId = routeParam(req, 'tableId');
    if (!id) return fail(res, 400, 'A stable commandId is required.');
    return respond(res, () => runLocalCommand(id, 'table.remove', { tableId }, () => {
      const table = findTable(tableId);
      if (!table) throw new Error('Table not found.');
      if (activeOrderAtTable(tableId)) throw new Error(`${table.name} has an open order. Settle or move it first.`);
      const kept = tableHasHistory(tableId);
      if (kept) db.prepare('UPDATE dining_tables SET active=0,name=? WHERE id=?').run(retiredName(table.name, tableId), tableId);
      else db.prepare('DELETE FROM dining_tables WHERE id=?').run(tableId);
      audit('setup', tableId, 'table.removed', null, { name: table.name, kept }, currentStaff(res).userId);
      return { id: tableId, removed: true };
    }));
  });

  app.post('/api/orders/:orderId/move', floorStaff, (req, res) => {
    const body = req.body as Record<string, unknown>; const id = commandId(body.commandId); const why = reason(body.reason);
    const tableId = typeof body.tableId === 'string' ? body.tableId : '';
    if (!id || !tableId || !why) return fail(res, 400, 'Choose a table and enter a reason of 3-120 characters.');
    const orderId = routeParam(req, 'orderId');
    try {
      const { duplicate } = runLocalCommand(id, 'order.move', { orderId, tableId, reason: why }, () => {
        const order = orderById(orderId);
        if (!order) throw new Error('Order not found.');
        if (!['sent', 'preparing', 'ready'].includes(order.status)) throw new Error('Only open, unpaid orders can be moved.');
        const table = findTable(tableId);
        if (!table) throw new Error('Choose a table that exists on this floor.');
        if (table.id === order.tableId) throw new Error(`This order is already at ${table.name}.`);
        if (activeOrderAtTable(table.id)) throw new Error(`${table.name} already has an open order. Merge the tables instead.`);
        const timestamp = new Date().toISOString();
        db.prepare("UPDATE orders SET order_type='dine_in',table_id=?,table_label=?,updated_at=? WHERE id=?").run(table.id, table.name, timestamp, orderId);
        audit('order', orderId, 'order.table_moved', why, { from: order.tableLabel, to: table.name }, currentStaff(res).userId);
        enqueueSyncEvent('order', orderId, 'order.table_moved', { ...orderById(orderId)! }, timestamp);
        return { orderId };
      });
      const order = orderById(orderId)!;
      if (!duplicate) publish('order.updated', order);
      return res.json(order);
    } catch (error) { return fail(res, 409, error instanceof Error ? error.message : 'Could not move this order.'); }
  });

  app.post('/api/orders/:orderId/merge', floorStaff, (req, res) => {
    const body = req.body as Record<string, unknown>; const id = commandId(body.commandId); const why = reason(body.reason);
    const targetOrderId = typeof body.targetOrderId === 'string' ? body.targetOrderId : '';
    if (!id || !targetOrderId || !why) return fail(res, 400, 'Choose the order to merge into and enter a reason of 3-120 characters.');
    // The cloud projection keys order lines by their original order, so merging stays local-only for now.
    if (setupMode() === 'cloud') return fail(res, 409, 'Merging tables is not available while this terminal syncs to the cloud.');
    const sourceId = routeParam(req, 'orderId');
    try {
      const { duplicate } = runLocalCommand(id, 'order.merge', { sourceId, targetOrderId, reason: why }, () => {
        const source = orderById(sourceId); const target = orderById(targetOrderId);
        if (!source || !target) throw new Error('Order not found.');
        if (source.id === target.id) throw new Error('Choose a different order to merge into.');
        for (const order of [source, target]) if (!['sent', 'preparing', 'ready'].includes(order.status)) throw new Error(`${order.orderNumber} is not open and cannot be merged.`);
        const timestamp = new Date().toISOString();
        db.prepare('UPDATE order_lines SET order_id=? WHERE order_id=?').run(target.id, source.id);
        db.prepare('UPDATE order_line_voids SET order_id=? WHERE order_id=?').run(target.id, source.id);
        // Kitchen tickets follow their lines; a station both orders use keeps one ticket at the least advanced status.
        const sourceTickets = db.prepare('SELECT id,station,status FROM kitchen_tickets WHERE order_id=?').all(source.id) as Array<{ id: string; station: string; status: string }>;
        for (const ticket of sourceTickets) {
          const existing = db.prepare('SELECT id,status FROM kitchen_tickets WHERE order_id=? AND station=?').get(target.id, ticket.station) as { id: string; status: string } | undefined;
          if (!existing) { db.prepare('UPDATE kitchen_tickets SET order_id=? WHERE id=?').run(target.id, ticket.id); continue; }
          const status = existing.status === 'voided' ? ticket.status : ticket.status === 'voided' ? existing.status
            : (TICKET_RANK[ticket.status] ?? 0) < (TICKET_RANK[existing.status] ?? 0) ? ticket.status : existing.status;
          db.prepare("UPDATE kitchen_tickets SET status=?,ready_at=CASE WHEN ?='ready' THEN ready_at ELSE NULL END WHERE id=?").run(status, status, existing.id);
          db.prepare('DELETE FROM kitchen_tickets WHERE id=?').run(ticket.id);
        }
        db.prepare('UPDATE orders SET guest_count=MIN(99,guest_count+?) WHERE id=?').run(source.guestCount, target.id);
        db.prepare("UPDATE orders SET status='cancelled',subtotal_minor=0,tax_total_minor=0,total_minor=0,note=?,updated_at=? WHERE id=?")
          .run(`Merged into ${target.orderNumber}`.slice(0, 140), timestamp, source.id);
        recalculateOrder(target.id, timestamp);
        refreshOrderKitchenStatus(target.id, timestamp);
        const actor = currentStaff(res).userId;
        audit('order', source.id, 'order.merged_away', why, { into: target.orderNumber, from: source.tableLabel }, actor);
        audit('order', target.id, 'order.merged_in', why, { from: source.orderNumber, fromTable: source.tableLabel }, actor);
        enqueueSyncEvent('order', source.id, 'order.merged_away', { ...orderById(source.id)! }, timestamp);
        enqueueSyncEvent('order', target.id, 'order.merged_in', { ...orderById(target.id)! }, timestamp);
        return { targetOrderId: target.id };
      });
      const target = orderById(targetOrderId)!;
      if (!duplicate) { publish('order.updated', orderById(sourceId)!); publish('order.updated', target); }
      return res.json(target);
    } catch (error) { return fail(res, 409, error instanceof Error ? error.message : 'Could not merge these orders.'); }
  });

  app.post('/api/orders/:orderId/bill', floorStaff, (req, res) => {
    const order = activeOrder(res, routeParam(req, 'orderId'));
    if (!order) return;
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE orders SET bill_printed_at=?,updated_at=? WHERE id=?').run(timestamp, timestamp, order.id);
      audit('order', order.id, 'order.bill_printed', null, { totalMinor: order.totalMinor, reprint: Boolean(order.billPrintedAt) }, currentStaff(res).userId);
    })();
    const after = orderById(order.id)!;
    queuePrint(formatBill(after, operationalSettings().defaultSac), 'Bill');
    publish('order.updated', after);
    return res.json(after);
  });
}
