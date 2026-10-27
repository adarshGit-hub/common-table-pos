import type { DailySalesReport, PaymentMethod, TableReport, TableReportRow } from '@common-table/contracts';
import { EDGE_CONFIG } from './config.js';
import { db } from './database.js';

function localMidnightUtc(year: number, month: number, day: number): Date {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: EDGE_CONFIG.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(candidate))
      .filter(part => part.type !== 'literal').map(part => [part.type, part.value])) as Record<string, string>;
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = target - observed;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

export function localBusinessDate(at = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: EDGE_CONFIG.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at).filter(part => part.type !== 'literal').map(part => [part.type, part.value])) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function reportRange(date: string): { startAt: string; endAt: string } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return undefined;
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    startAt: localMidnightUtc(year, month, day).toISOString(),
    endAt: localMidnightUtc(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate()).toISOString(),
  };
}

export function buildDailySalesReport(date = localBusinessDate()): DailySalesReport | undefined {
  const range = reportRange(date);
  if (!range) return undefined;
  const scope = [EDGE_CONFIG.tenantId, EDGE_CONFIG.outletId, range.startAt, range.endAt] as const;
  const totals = db.prepare(`WITH paid_orders AS (
      SELECT o.id,o.subtotal_minor,o.tax_total_minor,o.total_minor,o.discount_minor,o.service_charge_minor,o.round_off_minor
      FROM orders o WHERE o.tenant_id=? AND o.outlet_id=? AND o.status='paid'
        AND EXISTS (SELECT 1 FROM payment_events p WHERE p.tenant_id=o.tenant_id AND p.outlet_id=o.outlet_id
          AND p.order_id=o.id AND p.status='succeeded' AND p.entry_type='tender' AND p.created_at>=? AND p.created_at<?)
    ), refund_by_order AS (
      SELECT r.order_id,SUM(r.amount_minor) AS amount_minor
      FROM payment_events r WHERE r.tenant_id=? AND r.outlet_id=? AND r.status='succeeded' AND r.entry_type='refund'
        AND r.created_at>=? AND r.created_at<? GROUP BY r.order_id
    )
    SELECT COUNT(*) AS paid_order_count,
      COALESCE(SUM(p.total_minor-p.tax_total_minor-p.round_off_minor),0)-COALESCE((SELECT SUM(rb.amount_minor-ROUND(p2.tax_total_minor*1.0*rb.amount_minor/NULLIF(p2.total_minor,0)))
        FROM refund_by_order rb JOIN orders p2 ON p2.id=rb.order_id AND p2.tenant_id=? AND p2.outlet_id=?),0) AS subtotal_minor,
      COALESCE(SUM(p.tax_total_minor),0)-COALESCE((SELECT SUM(ROUND(p2.tax_total_minor*1.0*rb.amount_minor/NULLIF(p2.total_minor,0)))
        FROM refund_by_order rb JOIN orders p2 ON p2.id=rb.order_id AND p2.tenant_id=? AND p2.outlet_id=?),0) AS tax_total_minor,
      COALESCE(SUM(p.total_minor),0)-COALESCE((SELECT SUM(amount_minor) FROM refund_by_order),0) AS sales_minor,
      COALESCE(SUM(p.discount_minor),0) AS discount_minor,COALESCE(SUM(p.service_charge_minor),0) AS service_charge_minor,
      COALESCE(SUM(p.round_off_minor),0) AS round_off_minor
    FROM paid_orders p`)
    .get(...scope, ...scope, EDGE_CONFIG.tenantId, EDGE_CONFIG.outletId, EDGE_CONFIG.tenantId, EDGE_CONFIG.outletId) as {
      paid_order_count: number; subtotal_minor: number; tax_total_minor: number; sales_minor: number;
      discount_minor: number; service_charge_minor: number; round_off_minor: number };
  const refunds = db.prepare(`SELECT COUNT(*) AS refund_count,COALESCE(SUM(amount_minor),0) AS amount_minor
    FROM payment_events WHERE tenant_id=? AND outlet_id=? AND status='succeeded' AND entry_type='refund' AND created_at>=? AND created_at<?`)
    .get(...scope) as {refund_count:number;amount_minor:number};
  const tenders = db.prepare(`SELECT method,COALESCE(SUM(CASE WHEN entry_type='refund' THEN -amount_minor ELSE amount_minor END),0) AS amount_minor,
      SUM(CASE WHEN entry_type='tender' THEN 1 ELSE 0 END) AS payment_count
    FROM payment_events WHERE tenant_id=? AND outlet_id=? AND status='succeeded' AND created_at>=? AND created_at<?
    GROUP BY method ORDER BY method`)
    .all(...scope) as Array<{ method: PaymentMethod; amount_minor: number; payment_count: number }>;
  const items = db.prepare(`SELECT l.menu_item_id AS menu_item_id,l.item_name_snapshot AS name,
      COALESCE(SUM(l.quantity),0) AS quantity,COALESCE(SUM(l.line_total_minor),0) AS sales_minor
    FROM order_lines l JOIN orders o ON o.id=l.order_id AND o.tenant_id=l.tenant_id AND o.outlet_id=l.outlet_id
    LEFT JOIN order_line_voids v ON v.order_line_id=l.id
    WHERE l.tenant_id=? AND l.outlet_id=? AND o.status='paid'
      AND v.order_line_id IS NULL
      AND EXISTS (SELECT 1 FROM payment_events p WHERE p.tenant_id=o.tenant_id AND p.outlet_id=o.outlet_id
        AND p.order_id=o.id AND p.status='succeeded' AND p.entry_type='tender' AND p.created_at>=? AND p.created_at<?)
    GROUP BY l.menu_item_id,l.item_name_snapshot ORDER BY sales_minor DESC,name`)
    .all(...scope) as Array<{ menu_item_id: string; name: string; quantity: number; sales_minor: number }>;
  const taxRows = db.prepare(`SELECT o.id AS order_id,o.total_minor,o.tax_total_minor,l.tax_code_snapshot AS tax_code,
      l.tax_rate_bps,l.line_total_minor
    FROM orders o JOIN order_lines l ON l.order_id=o.id AND l.tenant_id=o.tenant_id AND l.outlet_id=o.outlet_id
    LEFT JOIN order_line_voids v ON v.order_line_id=l.id
    WHERE o.tenant_id=? AND o.outlet_id=? AND o.status='paid' AND v.order_line_id IS NULL
      AND EXISTS (SELECT 1 FROM payment_events p WHERE p.tenant_id=o.tenant_id AND p.outlet_id=o.outlet_id
        AND p.order_id=o.id AND p.status='succeeded' AND p.entry_type='tender' AND p.created_at>=? AND p.created_at<?)`)
    .all(...scope) as Array<{order_id:string;total_minor:number;tax_total_minor:number;tax_code:string|null;tax_rate_bps:number;line_total_minor:number}>;
  const refundsByOrder = db.prepare(`SELECT order_id,SUM(amount_minor) AS amount_minor FROM payment_events
    WHERE tenant_id=? AND outlet_id=? AND status='succeeded' AND entry_type='refund' AND created_at>=? AND created_at<? GROUP BY order_id`)
    .all(...scope) as Array<{order_id:string;amount_minor:number}>;
  const taxByOrder = new Map<string,{total:number;taxTotal:number;buckets:Map<string,{taxCode:string|null;taxRateBps:number;taxMinor:number}>}>();
  for (const row of taxRows) {
    const order=taxByOrder.get(row.order_id)??{total:Number(row.total_minor),taxTotal:Number(row.tax_total_minor),buckets:new Map()};
    const taxCode=row.tax_code??null;const taxRateBps=Number(row.tax_rate_bps);const key=`${taxRateBps}:${taxCode??''}`;
    const bucket=order.buckets.get(key)??{taxCode,taxRateBps,taxMinor:0};
    bucket.taxMinor+=Math.round(Number(row.line_total_minor)*taxRateBps/10000);order.buckets.set(key,bucket);taxByOrder.set(row.order_id,order);
  }
  const refundByOrder=new Map(refundsByOrder.map(row=>[row.order_id,Number(row.amount_minor)]));
  // Refunds of orders paid on an earlier day still reduce this day's tax, so load
  // their lines too; only their refunded share is counted below.
  const earlierOrderIds=new Set<string>();
  const earlierLines=db.prepare(`SELECT o.id AS order_id,o.total_minor,o.tax_total_minor,l.tax_code_snapshot AS tax_code,l.tax_rate_bps,l.line_total_minor
    FROM orders o JOIN order_lines l ON l.order_id=o.id AND l.tenant_id=o.tenant_id AND l.outlet_id=o.outlet_id
    LEFT JOIN order_line_voids v ON v.order_line_id=l.id
    WHERE o.tenant_id=? AND o.outlet_id=? AND o.id=? AND v.order_line_id IS NULL`);
  for(const orderId of refundByOrder.keys()){
    if(taxByOrder.has(orderId))continue;
    earlierOrderIds.add(orderId);
    for(const row of earlierLines.all(EDGE_CONFIG.tenantId,EDGE_CONFIG.outletId,orderId) as typeof taxRows){
      const order=taxByOrder.get(row.order_id)??{total:Number(row.total_minor),taxTotal:Number(row.tax_total_minor),buckets:new Map()};
      const taxCode=row.tax_code??null;const taxRateBps=Number(row.tax_rate_bps);const key=`${taxRateBps}:${taxCode??''}`;
      const bucket=order.buckets.get(key)??{taxCode,taxRateBps,taxMinor:0};
      bucket.taxMinor+=Math.round(Number(row.line_total_minor)*taxRateBps/10000);order.buckets.set(key,bucket);taxByOrder.set(row.order_id,order);
    }
  }
  // Orders priced by the GST engine store their tax lines (after discounts and service
  // charge); use those instead of re-deriving tax from item lines.
  const storedTaxLines=db.prepare('SELECT tax_rate_bps,tax_code,cgst_minor,sgst_minor FROM order_tax_lines WHERE order_id=?');
  for(const [orderId,order] of taxByOrder){
    const stored=storedTaxLines.all(orderId) as Array<{tax_rate_bps:number;tax_code:string;cgst_minor:number;sgst_minor:number}>;
    if(stored.length)order.buckets=new Map(stored.map(row=>[`${row.tax_rate_bps}:${row.tax_code}`,
      {taxCode:row.tax_code||null,taxRateBps:Number(row.tax_rate_bps),taxMinor:Number(row.cgst_minor)+Number(row.sgst_minor)}]));
  }
  const taxBreakdownMap=new Map<string,{taxCode:string|null;taxRateBps:number;taxMinor:number}>();
  for(const [orderId,order] of taxByOrder){
    const soldToday=!earlierOrderIds.has(orderId);
    const refund=Math.min(order.total,refundByOrder.get(orderId)??0);const targetRefundTax=order.total?Math.round(order.taxTotal*refund/order.total):0;
    let allocated=0;const buckets=[...order.buckets.values()];
    buckets.forEach((bucket,index)=>{
      const refundTax=index===buckets.length-1?targetRefundTax-allocated:(order.total?Math.round(bucket.taxMinor*refund/order.total):0);
      allocated+=refundTax;const key=`${bucket.taxRateBps}:${bucket.taxCode??''}`;
      const aggregate=taxBreakdownMap.get(key)??{...bucket,taxMinor:0};aggregate.taxMinor+=(soldToday?bucket.taxMinor:0)-refundTax;taxBreakdownMap.set(key,aggregate);
    });
  }
  const voids = db.prepare(`SELECT COUNT(*) AS line_count,COALESCE(SUM(l.quantity),0) AS quantity,
      COALESCE(SUM(l.line_total_minor),0) AS amount_minor
    FROM order_line_voids v JOIN order_lines l ON l.id=v.order_line_id
    WHERE v.tenant_id=? AND v.outlet_id=? AND v.voided_at>=? AND v.voided_at<?`)
    .get(...scope) as { line_count: number; quantity: number; amount_minor: number };
  const shifts = db.prepare(`SELECT COUNT(*) AS closed_count,COALESCE(SUM(expected_cash_minor),0) AS expected_cash_minor,
      COALESCE(SUM(counted_cash_minor),0) AS counted_cash_minor,COALESCE(SUM(variance_minor),0) AS variance_minor
    FROM shifts WHERE tenant_id=? AND outlet_id=? AND status='closed' AND closed_at>=? AND closed_at<?`)
    .get(...scope) as { closed_count: number; expected_cash_minor: number; counted_cash_minor: number; variance_minor: number };
  return {
    date, timeZone: EDGE_CONFIG.timezone, outletName: EDGE_CONFIG.outletName, currency: EDGE_CONFIG.currency,
    ...range, generatedAt: new Date().toISOString(),
    totals: { paidOrderCount: Number(totals.paid_order_count), subtotalMinor: Number(totals.subtotal_minor), taxTotalMinor: Number(totals.tax_total_minor), salesMinor: Number(totals.sales_minor),
      discountMinor: Number(totals.discount_minor), serviceChargeMinor: Number(totals.service_charge_minor), roundOffMinor: Number(totals.round_off_minor) },
    taxBreakdown: [...taxBreakdownMap.values()].map(row => { const cgstMinor = Math.round(row.taxMinor / 2); return { ...row, cgstMinor, sgstMinor: row.taxMinor - cgstMinor }; }).sort((a,b)=>a.taxRateBps-b.taxRateBps||(a.taxCode??'').localeCompare(b.taxCode??'')),
    refunds: { count: Number(refunds.refund_count), amountMinor: Number(refunds.amount_minor) },
    tenders: tenders.map(row => ({ method: row.method, amountMinor: Number(row.amount_minor), paymentCount: Number(row.payment_count) })),
    items: items.map(row => ({ menuItemId: row.menu_item_id, name: row.name, quantity: Number(row.quantity), salesMinor: Number(row.sales_minor) })),
    voids: { lineCount: Number(voids.line_count), quantity: Number(voids.quantity), amountMinor: Number(voids.amount_minor) },
    shifts: { closedCount: Number(shifts.closed_count), expectedCashMinor: Number(shifts.expected_cash_minor), countedCashMinor: Number(shifts.counted_cash_minor), varianceMinor: Number(shifts.variance_minor) },
  };
}

function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function dailySalesCsv(report: DailySalesReport): string {
  const rows: Array<Array<string | number>> = [
    ['section', 'metric', 'quantity', 'amount_minor', 'currency', 'details'],
    ['report', 'date', '', '', report.currency, report.date],
    ['sales', 'paid_orders', report.totals.paidOrderCount, '', report.currency, report.timeZone],
    ['sales', 'subtotal', '', report.totals.subtotalMinor, report.currency, ''],
    ['sales', 'tax', '', report.totals.taxTotalMinor, report.currency, ''],
    ['sales', 'discounts', '', report.totals.discountMinor, report.currency, 'before tax'],
    ['sales', 'service_charge', '', report.totals.serviceChargeMinor, report.currency, ''],
    ['sales', 'round_off', '', report.totals.roundOffMinor, report.currency, ''],
    ...report.taxBreakdown.flatMap(row => [
      ['tax_rate', `${(row.taxRateBps/100).toFixed(2)}%`, '', row.taxMinor, report.currency, row.taxCode ?? 'unclassified'],
      ['cgst', `${(row.taxRateBps/200).toFixed(2)}%`, '', row.cgstMinor, report.currency, row.taxCode ?? 'unclassified'],
      ['sgst', `${(row.taxRateBps/200).toFixed(2)}%`, '', row.sgstMinor, report.currency, row.taxCode ?? 'unclassified'],
    ]),
    ['sales', 'net_sales', '', report.totals.salesMinor, report.currency, 'after refunds'],
    ['refunds', 'refunds', report.refunds.count, report.refunds.amountMinor, report.currency, ''],
    ...report.tenders.map(row => ['tender', row.method, row.paymentCount, row.amountMinor, report.currency, '']),
    ...report.items.map(row => ['item', row.name, row.quantity, row.salesMinor, report.currency, row.menuItemId]),
    ['voids', 'voided_lines', report.voids.lineCount, report.voids.amountMinor, report.currency, `${report.voids.quantity} units`],
    ['shifts', 'closed_shifts', report.shifts.closedCount, report.shifts.varianceMinor, report.currency, `expected ${report.shifts.expectedCashMinor}; counted ${report.shifts.countedCashMinor}`],
  ];
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Dine-in performance per table and per area for orders settled on the business day. */
export function buildTableReport(date = localBusinessDate()): TableReport | undefined {
  const range = reportRange(date);
  if (!range) return undefined;
  const rows = db.prepare(`SELECT o.table_id AS tableId,o.table_label AS tableLabel,o.guest_count AS guestCount,o.total_minor AS totalMinor,
      o.created_at AS createdAt,t.name AS tableName,t.active AS tableActive,a.name AS areaName,
      (SELECT MIN(p.created_at) FROM payment_events p WHERE p.order_id=o.id AND p.status='succeeded' AND p.entry_type='tender') AS paidAt
    FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id LEFT JOIN dining_areas a ON a.id=t.area_id
    WHERE o.tenant_id=? AND o.outlet_id=? AND o.status='paid' AND o.order_type='dine_in'
      AND EXISTS (SELECT 1 FROM payment_events p WHERE p.tenant_id=o.tenant_id AND p.outlet_id=o.outlet_id
        AND p.order_id=o.id AND p.status='succeeded' AND p.entry_type='tender' AND p.created_at>=? AND p.created_at<?)`)
    .all(EDGE_CONFIG.tenantId, EDGE_CONFIG.outletId, range.startAt, range.endAt) as Array<{
      tableId: string | null; tableLabel: string | null; guestCount: number; totalMinor: number; createdAt: string;
      tableName: string | null; tableActive: number | null; areaName: string | null; paidAt: string }>;
  type Bucket = { tableId: string | null; tableName: string; areaName: string; orders: number; guests: number; sales: number; minutes: number };
  const tables = new Map<string, Bucket>();
  for (const row of rows) {
    // Removed tables keep their order history under the name they were served with.
    const tableName = row.tableActive ? row.tableName! : row.tableLabel ?? 'Unassigned';
    const key = row.tableId ?? `label:${tableName}`;
    const bucket = tables.get(key) ?? { tableId: row.tableId, tableName, areaName: row.areaName?.replace(/ \(removed [0-9a-f]{6}\)$/, '') ?? 'Unassigned', orders: 0, guests: 0, sales: 0, minutes: 0 };
    bucket.orders += 1; bucket.guests += Number(row.guestCount); bucket.sales += Number(row.totalMinor);
    bucket.minutes += Math.max(0, (Date.parse(row.paidAt) - Date.parse(row.createdAt)) / 60000);
    tables.set(key, bucket);
  }
  const finish = (bucket: Omit<Bucket, 'tableId' | 'tableName'>): Omit<TableReportRow, 'tableId' | 'tableName'> => ({
    areaName: bucket.areaName, orderCount: bucket.orders, guestCount: bucket.guests, salesMinor: bucket.sales,
    averageBillMinor: bucket.orders ? Math.round(bucket.sales / bucket.orders) : 0,
    averageSeatedMinutes: bucket.orders ? Math.round(bucket.minutes / bucket.orders) : 0,
  });
  const areas = new Map<string, Omit<Bucket, 'tableId' | 'tableName'>>();
  for (const bucket of tables.values()) {
    const area = areas.get(bucket.areaName) ?? { areaName: bucket.areaName, orders: 0, guests: 0, sales: 0, minutes: 0 };
    area.orders += bucket.orders; area.guests += bucket.guests; area.sales += bucket.sales; area.minutes += bucket.minutes;
    areas.set(bucket.areaName, area);
  }
  return {
    date, currency: EDGE_CONFIG.currency,
    tables: [...tables.values()].map(bucket => ({ tableId: bucket.tableId, tableName: bucket.tableName, ...finish(bucket) }))
      .sort((a, b) => b.salesMinor - a.salesMinor || a.tableName.localeCompare(b.tableName)),
    areas: [...areas.values()].map(finish).sort((a, b) => b.salesMinor - a.salesMinor),
  };
}

export function tableReportCsv(report: TableReport): string {
  const header = ['level', 'area', 'table', 'orders', 'guests', 'sales_minor', 'average_bill_minor', 'average_seated_minutes', 'currency'];
  const rows: Array<Array<string | number>> = [header,
    ...report.areas.map(row => ['area', row.areaName, '', row.orderCount, row.guestCount, row.salesMinor, row.averageBillMinor, row.averageSeatedMinutes, report.currency]),
    ...report.tables.map(row => ['table', row.areaName, row.tableName, row.orderCount, row.guestCount, row.salesMinor, row.averageBillMinor, row.averageSeatedMinutes, report.currency])];
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
