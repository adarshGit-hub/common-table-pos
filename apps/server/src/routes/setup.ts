// Floor plan and menu reads.
import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AddOrderLinesCommand, CashMovementCommand, CreateOrderCommand, KitchenOrder, OrderLine, OrderLineDraft, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage, ShiftRecord, ShiftSummary } from '@common-table/contracts';
import { allocateNumber, createId, db, DATABASE_PATH, DEMO_ACTOR, DEMO_OUTLET, DEMO_TENANT, DEMO_TERMINAL, discardStaleInventoryCount, enqueueSyncEvent, listInventoryCountConflicts, localInventoryBalances, recordManualInventoryMovement, recordPaidOrderInventoryConsumption, syncOutboxStatus } from '../database.js';
import { checkEdgeConfiguration, EDGE_CONFIG, setupMode } from '../config.js';
import { formatKitchenTicket, formatReceipt, printerStatus, sendToPrinter } from '../printer.js';
import { buildDailySalesReport, dailySalesCsv, localBusinessDate } from '../reports.js';
import { getSyncStatus, syncMenuOnce } from '../sync.js';
import { clearedSessionCookie, createStaffSession, currentStaff, readStaffSession, refreshStaffSession, requireRoles, sessionCookie, StaffAuthError } from '../auth.js';
import { fail, queuePrint, routeParam, mapLines, mapOrder, orderById, mapShift, shiftSummary, kitchenOrders, kitchenSnapshot, refreshOrderKitchenStatus, audit, prepareLines, recalculateOrder, rememberEdit, editReplay, persistAddedLines, createOrder, type PreparedOrderLine } from '../core.js';
import { publish } from '../realtime.js';

export function registerSetupRoutes(app:Express){
app.get('/api/floor-plan',requireRoles('owner','manager','cashier'),(_req,res)=>{
  const areas=db.prepare('SELECT id,name,sort_order AS sortOrder FROM dining_areas WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order,name')
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<{id:string;name:string;sortOrder:number}>;
  const tables=db.prepare(`SELECT id,area_id AS areaId,name,capacity,sort_order AS sortOrder FROM dining_tables
    WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order,name`).all(DEMO_TENANT,DEMO_OUTLET) as Array<{id:string;areaId:string;name:string;capacity:number;sortOrder:number}>;
  const stations=db.prepare('SELECT id,name,sort_order AS sortOrder FROM kitchen_stations WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order,name')
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<{id:string;name:string;sortOrder:number}>;
  const occupied=new Set((db.prepare(`SELECT DISTINCT table_label AS name FROM orders WHERE tenant_id=? AND outlet_id=?
    AND table_label IS NOT NULL AND status IN ('sent','preparing','ready')`).all(DEMO_TENANT,DEMO_OUTLET) as Array<{name:string}>).map(row=>row.name));
  return res.json({areas:areas.map(area=>({...area,tables:tables.filter(table=>table.areaId===area.id).map(({areaId,...table})=>({...table,occupied:occupied.has(table.name)}))})),stations});
});
app.get('/api/menu',requireRoles('owner','manager','cashier','kitchen','viewer'),(_req,res)=>{
  // Standalone tills list sold-out items too so staff can mark them back in stock;
  // a cloud snapshot uses available=0 for removed items, so paired tills hide them.
  const rows=db.prepare(`SELECT id,name,category,price_minor AS priceMinor,emoji,color,tag,vegetarian,available,kitchen_station AS kitchenStation,tax_code AS taxCode,tax_rate_bps AS taxRateBps FROM menu_items WHERE tenant_id=? AND outlet_id=? AND ${setupMode()==='standalone'?'archived=0':'available=1'} ORDER BY rowid`)
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  const modifiers=db.prepare(`SELECT id,menu_item_id AS menuItemId,group_name AS "group",name,price_delta_minor AS priceDeltaMinor FROM menu_modifiers WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order`)
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  res.json(rows.map(row=>({...row,priceMinor:Number(row.priceMinor),vegetarian:Boolean(row.vegetarian),available:Boolean(row.available),modifiers:modifiers.filter(modifier=>modifier.menuItemId===row.id).map(({menuItemId,...modifier})=>({...modifier,priceDeltaMinor:Number(modifier.priceDeltaMinor)}))})));
});
}
