// Discounts, service charge and outlet settings for the local cashier service.
import type { Express, Response } from 'express';
import { priceBill, roundToMinorFor, type PricingDiscount } from '@common-table/contracts';
import { createId, db, DEMO_OUTLET, DEMO_TENANT, enqueueSyncEvent } from '../database.js';
import { applyOutletRuntimeSettings, EDGE_CONFIG, setupMode, type OutletRuntimeSettings } from '../config.js';
import { currentStaff, requireRoles } from '../auth.js';
import { activeDiscounts, audit, fail, orderById, recalculateOrder, routeParam } from '../core.js';
import { mergeOperationalSettings, operationalSettings, saveOperationalSettings } from '../settings.js';
import { publish } from '../realtime.js';

const floorStaff = requireRoles('owner', 'manager', 'cashier');

function reasonText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length >= 3 && text.length <= 120 && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}
function validCommand(value: unknown): value is string { return typeof value === 'string' && value.length >= 8 && value.length <= 160; }

function editableOrder(res: Response, orderId: string) {
  const order = orderById(orderId);
  if (!order) { fail(res, 404, 'Order not found.'); return undefined; }
  if (!['sent', 'preparing', 'ready'].includes(order.status)) { fail(res, 409, 'Only open, unpaid orders can be changed.'); return undefined; }
  if ((order.pricingVersion ?? 1) < 2) { fail(res, 409, 'This order was opened before discounts were available. Settle it as it is.'); return undefined; }
  return order;
}

function settingsView() {
  return {
    setupMode: setupMode(), ...operationalSettings(),
    outlet: { name: EDGE_CONFIG.outletName, taxRateBps: EDGE_CONFIG.taxRateBps, receiptName: EDGE_CONFIG.receiptName,
      receiptAddress: EDGE_CONFIG.receiptAddress, receiptPhone: EDGE_CONFIG.receiptPhone, gstin: EDGE_CONFIG.gstin, receiptFooter: EDGE_CONFIG.receiptFooter },
  };
}

export function registerBillingRoutes(app: Express) {
  app.post('/api/orders/:orderId/discounts', floorStaff, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const reason = reasonText(body.reason);
    const kind = body.kind === 'percent' || body.kind === 'amount' ? body.kind : undefined;
    const value = Number(body.value);
    const lineId = typeof body.lineId === 'string' && body.lineId ? body.lineId : null;
    if (!validCommand(body.commandId) || !kind || !reason || !Number.isSafeInteger(value) || value <= 0 || (kind === 'percent' && value > 10000))
      return fail(res, 400, 'Choose a percentage (up to 100%) or an amount, and enter a reason of 3-120 characters.');
    const orderId = routeParam(req, 'orderId');
    const replay = db.prepare('SELECT order_id,order_line_id,kind,value FROM order_discounts WHERE command_id=?').get(body.commandId) as
      { order_id: string; order_line_id: string | null; kind: string; value: number } | undefined;
    if (replay) {
      if (replay.order_id !== orderId || replay.order_line_id !== lineId || replay.kind !== kind || Number(replay.value) !== value)
        return fail(res, 409, 'This discount command was already used for a different discount.');
      return res.json(orderById(orderId));
    }
    const order = editableOrder(res, orderId);
    if (!order) return;
    const line = lineId ? order.lines.find(candidate => candidate.id === lineId && !candidate.voidedAt) : undefined;
    if (lineId && !line) return fail(res, 404, 'That item is not on this order.');
    const staff = currentStaff(res);
    // Cashiers may discount up to the configured share of the bill; larger discounts need a manager.
    if (staff.role === 'cashier') {
      const lines = order.lines.filter(candidate => !candidate.voidedAt)
        .map(candidate => ({ id: candidate.id, lineTotalMinor: candidate.lineTotalMinor, taxRateBps: candidate.taxRateBps ?? order.taxRateBps, taxCode: candidate.taxCode ?? null }));
      const discounts: PricingDiscount[] = [...(order.discounts ?? []).map(({ lineId: id, kind: k, value: v }) => ({ lineId: id, kind: k, value: v })), { lineId, kind, value }];
      const after = priceBill({ lines, discounts, serviceChargeBps: order.serviceChargeBps ?? 0, serviceTaxRateBps: EDGE_CONFIG.taxRateBps, roundToMinor: roundToMinorFor(order.currency) });
      const limitBps = operationalSettings().cashierDiscountLimitBps;
      if (after.discountMinor > Math.round(after.subtotalMinor * limitBps / 10000))
        return fail(res, 403, `Discounts above ${limitBps / 100}% of the bill need a manager.`);
    }
    const timestamp = new Date().toISOString();
    db.transaction(() => {
      const id = createId();
      db.prepare(`INSERT INTO order_discounts(id,command_id,tenant_id,outlet_id,order_id,order_line_id,kind,value,reason,actor_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, body.commandId, DEMO_TENANT, DEMO_OUTLET, orderId, lineId, kind, value, reason, staff.userId, timestamp);
      recalculateOrder(orderId, timestamp);
      audit('order', orderId, 'order.discount_applied', reason, { discountId: id, lineId, itemName: line?.name ?? null, kind, value }, staff.userId);
      enqueueSyncEvent('order', orderId, 'order.discount_applied', { ...orderById(orderId)! }, timestamp);
    })();
    const after = orderById(orderId)!;
    publish('order.updated', after);
    return res.status(201).json(after);
  });

  app.post('/api/orders/:orderId/discounts/:discountId/void', floorStaff, (req, res) => {
    const body = req.body as Record<string, unknown>; const reason = reasonText(body.reason);
    if (!reason) return fail(res, 400, 'Enter a reason of 3-120 characters.');
    const orderId = routeParam(req, 'orderId'); const discountId = routeParam(req, 'discountId');
    const discount = activeDiscounts(orderId).find(row => row.id === discountId);
    if (!discount) {
      const existing = db.prepare('SELECT voided_at FROM order_discounts WHERE id=? AND order_id=?').get(discountId, orderId) as { voided_at: string | null } | undefined;
      if (existing?.voided_at) return res.json(orderById(orderId));
      return fail(res, 404, 'Discount not found on this order.');
    }
    if (!editableOrder(res, orderId)) return;
    const staff = currentStaff(res); const timestamp = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE order_discounts SET voided_at=?,void_reason=?,voided_by=? WHERE id=? AND voided_at IS NULL').run(timestamp, reason, staff.userId, discountId);
      recalculateOrder(orderId, timestamp);
      audit('order', orderId, 'order.discount_removed', reason, { discountId }, staff.userId);
      enqueueSyncEvent('order', orderId, 'order.discount_removed', { ...orderById(orderId)! }, timestamp);
    })();
    const after = orderById(orderId)!;
    publish('order.updated', after);
    return res.json(after);
  });

  // Service charge is optional for the guest; the cashier removes it on request (or restores it).
  app.post('/api/orders/:orderId/service-charge', floorStaff, (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean') return fail(res, 400, 'Say whether the service charge applies.');
    const reason = body.enabled ? null : reasonText(body.reason) ?? null;
    if (!body.enabled && !reason) return fail(res, 400, 'Enter why the service charge is removed.');
    const order = editableOrder(res, routeParam(req, 'orderId'));
    if (!order) return;
    const bps = body.enabled ? (order.orderType === 'dine_in' ? operationalSettings().serviceChargeBps : 0) : 0;
    if (bps === (order.serviceChargeBps ?? 0)) return res.json(order);
    const staff = currentStaff(res); const timestamp = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE orders SET service_charge_bps=? WHERE id=?').run(bps, order.id);
      recalculateOrder(order.id, timestamp);
      audit('order', order.id, body.enabled ? 'order.service_charge_added' : 'order.service_charge_removed', reason, { serviceChargeBps: bps }, staff.userId);
      enqueueSyncEvent('order', order.id, 'order.service_charge_changed', { ...orderById(order.id)! }, timestamp);
    })();
    const after = orderById(order.id)!;
    publish('order.updated', after);
    return res.json(after);
  });

  app.get('/api/settings', floorStaff, (_req, res) => res.json(settingsView()));

  app.patch('/api/settings', requireRoles('owner', 'manager'), (req, res) => {
    const body = req.body as Record<string, unknown>;
    const merged = mergeOperationalSettings(body);
    if (typeof merged === 'string') return fail(res, 400, merged);
    const outletPatch = body.outlet && typeof body.outlet === 'object' && !Array.isArray(body.outlet) ? body.outlet as Record<string, unknown> : undefined;
    // Outlet identity comes from the cloud once paired; local operational settings stay editable.
    if (outletPatch && setupMode() === 'cloud') return fail(res, 409, 'Outlet name, tax and receipt details are managed in the cloud portal.');
    let outlet: OutletRuntimeSettings | undefined;
    if (outletPatch) {
      try {
        outlet = applyOutletRuntimeSettings({
          name: outletPatch.name ?? EDGE_CONFIG.outletName, timezone: EDGE_CONFIG.timezone, currency: EDGE_CONFIG.currency,
          taxRateBps: outletPatch.taxRateBps ?? EDGE_CONFIG.taxRateBps, receiptName: outletPatch.receiptName ?? EDGE_CONFIG.receiptName,
          receiptAddress: outletPatch.receiptAddress ?? EDGE_CONFIG.receiptAddress, receiptPhone: outletPatch.receiptPhone ?? EDGE_CONFIG.receiptPhone,
          gstin: outletPatch.gstin ?? EDGE_CONFIG.gstin, receiptFooter: outletPatch.receiptFooter ?? EDGE_CONFIG.receiptFooter,
        });
      } catch (error) { return fail(res, 400, error instanceof Error ? error.message : 'Outlet settings are invalid.'); }
    }
    const staff = currentStaff(res);
    db.transaction(() => {
      saveOperationalSettings(merged);
      if (outlet) db.prepare(`UPDATE outlets SET name=?,tax_rate_bps=?,receipt_name=?,receipt_address=?,receipt_phone=?,gstin=?,receipt_footer=? WHERE id=? AND tenant_id=?`)
        .run(outlet.name, outlet.taxRateBps, outlet.receiptName || null, outlet.receiptAddress || null, outlet.receiptPhone || null,
          outlet.gstin || null, outlet.receiptFooter || null, DEMO_OUTLET, DEMO_TENANT);
      audit('setup', DEMO_OUTLET, 'settings.updated', null, { operational: merged, outlet: outlet ?? null }, staff.userId);
    })();
    publish('floor.updated', { outletId: DEMO_OUTLET });
    return res.json(settingsView());
  });
}
