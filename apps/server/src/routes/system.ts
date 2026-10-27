// Sync status, support diagnostics and printer check.
import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AddOrderLinesCommand, CashMovementCommand, CreateOrderCommand, KitchenOrder, OrderLine, OrderLineDraft, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage, ShiftRecord, ShiftSummary } from '@common-table/contracts';
import { allocateNumber, createId, db, DATABASE_PATH, DEMO_ACTOR, DEMO_OUTLET, DEMO_TENANT, DEMO_TERMINAL, discardStaleInventoryCount, enqueueSyncEvent, listInventoryCountConflicts, localInventoryBalances, recordManualInventoryMovement, recordPaidOrderInventoryConsumption, syncOutboxStatus } from '../database.js';
import { checkEdgeConfiguration, EDGE_CONFIG } from '../config.js';
import { formatKitchenTicket, formatReceipt, printerStatus, sendToPrinter } from '../printer.js';
import { buildDailySalesReport, dailySalesCsv, localBusinessDate } from '../reports.js';
import { getSyncStatus, syncMenuOnce } from '../sync.js';
import { clearedSessionCookie, createStaffSession, currentStaff, readStaffSession, refreshStaffSession, requireRoles, sessionCookie, StaffAuthError } from '../auth.js';
import { fail, queuePrint, routeParam, mapLines, mapOrder, orderById, mapShift, shiftSummary, kitchenOrders, kitchenSnapshot, refreshOrderKitchenStatus, audit, prepareLines, recalculateOrder, rememberEdit, editReplay, persistAddedLines, createOrder, type PreparedOrderLine } from '../core.js';
import { publish } from '../realtime.js';

export function registerSystemRoutes(app:Express){
app.get('/api/sync/status',requireRoles('owner','manager','cashier','kitchen','viewer'),(_req,res)=>res.json({...getSyncStatus(),outbox:syncOutboxStatus()}));
app.get('/api/support/diagnostics.json',requireRoles('owner','manager'),(_req,res)=>{
  const integrity=(db.pragma('quick_check') as Array<{quick_check?:string}>).map(row=>row.quick_check??'unknown');
  const foreignKeyViolations=(db.pragma('foreign_key_check') as unknown[]).length;
  const availableMenuItems=Number((db.prepare('SELECT COUNT(*) AS count FROM menu_items WHERE tenant_id=? AND outlet_id=? AND available=1')
    .get(DEMO_TENANT,DEMO_OUTLET) as {count:number}).count);
  const orderStates=db.prepare('SELECT status,COUNT(*) AS count FROM orders WHERE tenant_id=? AND outlet_id=? GROUP BY status ORDER BY status')
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<{status:string;count:number}>;
  const sync=getSyncStatus();
  const outbox=syncOutboxStatus();
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('content-disposition','attachment; filename="common-table-edge-diagnostics.json"');
  return res.json({
    generatedAt:new Date().toISOString(),service:'common-table-edge',
    outlet:{tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,name:EDGE_CONFIG.outletName,terminalId:DEMO_TERMINAL},
    process:{node:process.version,uptimeSeconds:Math.floor(process.uptime())},
    database:{integrity:integrity.length===1&&integrity[0]==='ok'?'ok':'failed',foreignKeyViolations,availableMenuItems,orderStates},
    sync:{configured:sync.configured,pending:outbox.pending,failed:outbox.failed,lastSyncedAt:outbox.lastSyncedAt,
      errorPresent:Boolean(sync.lastError),menu:{version:sync.menu?.version??null,lastSyncedAt:sync.menu?.lastSyncedAt??null,errorPresent:Boolean(sync.menu?.lastError)}},
    printer:printerStatus(),
  });
});
app.post('/api/printer/test',requireRoles('owner','manager'),(_req,res)=>{
  const printer=printerStatus();
  if(printer.mode==='disabled')return fail(res,503,'Printer output is disabled on this edge.');
  const sample:KitchenOrder={id:'sample',orderNumber:'J-ORD-000001',orderType:'takeaway',tableLabel:null,status:'sent',note:'Printer connection check',createdAt:new Date().toISOString(),lines:[]};
  void sendToPrinter(formatKitchenTicket(sample)).catch(error=>console.error('Printer test failed:',error));
  return res.json({status:'queued',...printer});
});
}
