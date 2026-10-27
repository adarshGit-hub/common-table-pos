// Shift open, cash movement and close.
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

export function registerShiftRoutes(app:Express){
app.get('/api/shifts/current',requireRoles('owner','manager','cashier'),(_req,res)=>{
  const row=db.prepare("SELECT id FROM shifts WHERE tenant_id=? AND outlet_id=? AND status='open'").get(DEMO_TENANT,DEMO_OUTLET) as {id:string}|undefined;
  return res.json({shift:row?shiftSummary(row.id):null});
});
app.post('/api/shifts/open',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as {commandId?:unknown;openingFloatMinor?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required to open a shift.');
  const openingFloatMinor=Number(body.openingFloatMinor);
  if(!Number.isSafeInteger(openingFloatMinor)||openingFloatMinor<0)return fail(res,400,'Opening float must be a non-negative amount in minor currency units.');
  const replay=db.prepare('SELECT id FROM shifts WHERE command_id=?').get(body.commandId) as {id:string}|undefined;
  if(replay)return res.json(shiftSummary(replay.id));
  const current=db.prepare("SELECT id FROM shifts WHERE tenant_id=? AND outlet_id=? AND status='open'").get(DEMO_TENANT,DEMO_OUTLET);
  if(current)return fail(res,409,'A shift is already open for this outlet.');
  const id=createId();const openedAt=new Date().toISOString();
  try{db.transaction(()=>{
    const shiftNumber=allocateNumber('shift','SHIFT');
    db.prepare(`INSERT INTO shifts(id,command_id,tenant_id,outlet_id,terminal_id,actor_id,shift_number,opening_float_minor,status,opened_at)
      VALUES(?,?,?,?,?,?,?,?,'open',?)`).run(id,body.commandId,DEMO_TENANT,DEMO_OUTLET,DEMO_TERMINAL,currentStaff(res).userId,shiftNumber,openingFloatMinor,openedAt);
    audit('shift',id,'shift.opened',null,{shiftNumber,openingFloatMinor},currentStaff(res).userId);
    enqueueSyncEvent('shift',id,'shift.opened',{id,shiftNumber,status:'open',openedAt,openingFloatMinor,
      tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},openedAt);
  })();}catch(error){return fail(res,409,error instanceof Error?error.message:'Unable to open shift.');}
  return res.status(201).json(shiftSummary(id));
});
app.post('/api/shifts/:shiftId/cash-movements',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as Partial<CashMovementCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for cash movement.');
  if(body.type!=='cash_in'&&body.type!=='cash_out')return fail(res,400,'Choose cash in or cash out.');
  const amountMinor=Number(body.amountMinor);if(!Number.isSafeInteger(amountMinor)||amountMinor<=0)return fail(res,400,'Cash movement must be greater than zero.');
  const reason=typeof body.reason==='string'?body.reason.trim():'';if(reason.length<3||reason.length>120)return fail(res,400,'Enter a reason between 3 and 120 characters.');
  const replay=db.prepare('SELECT shift_id FROM cash_movements WHERE command_id=?').get(body.commandId) as {shift_id:string}|undefined;
  if(replay){
    if(replay.shift_id!==routeParam(req,'shiftId'))return fail(res,409,'This cash movement command was already used for a different shift.');
    return res.json(shiftSummary(replay.shift_id));
  }
  const shift=db.prepare("SELECT id FROM shifts WHERE id=? AND tenant_id=? AND outlet_id=? AND status='open'").get(routeParam(req,'shiftId'),DEMO_TENANT,DEMO_OUTLET);
  if(!shift)return fail(res,409,'Open a shift before recording cash movement.');
  db.transaction(()=>{
    const movementId=createId();const occurredAt=new Date().toISOString();
    db.prepare(`INSERT INTO cash_movements(id,command_id,tenant_id,outlet_id,shift_id,terminal_id,actor_id,movement_type,amount_minor,reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(movementId,body.commandId,DEMO_TENANT,DEMO_OUTLET,routeParam(req,'shiftId'),DEMO_TERMINAL,currentStaff(res).userId,body.type,amountMinor,reason,occurredAt);
    audit('shift',routeParam(req,'shiftId'),`shift.${body.type}`,reason,{amountMinor,commandId:body.commandId},currentStaff(res).userId);
    enqueueSyncEvent('cash_movement',movementId,`shift.${body.type}`,{id:movementId,commandId:body.commandId,shiftId:routeParam(req,'shiftId'),
      movementType:body.type,amountMinor,reason,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL,actorId:currentStaff(res).userId},occurredAt);
  })();
  return res.status(201).json(shiftSummary(routeParam(req,'shiftId')));
});
app.post('/api/shifts/:shiftId/close',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as {commandId?:unknown;countedCashMinor?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required to close a shift.');
  const countedCashMinor=Number(body.countedCashMinor);if(!Number.isSafeInteger(countedCashMinor)||countedCashMinor<0)return fail(res,400,'Counted cash must be a non-negative amount in minor currency units.');
  const replay=db.prepare('SELECT id FROM shifts WHERE close_command_id=?').get(body.commandId) as {id:string}|undefined;
  if(replay)return res.json(shiftSummary(replay.id));
  const summary=shiftSummary(routeParam(req,'shiftId'));if(!summary||summary.shift.status!=='open')return fail(res,409,'This shift is not open.');
  // Orders can be taken before a shift opens, so every unsettled order blocks close.
  const unsettled=db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE tenant_id=? AND outlet_id=? AND status IN ('sent','preparing','ready')`)
    .get(DEMO_TENANT,DEMO_OUTLET) as {count:number};
  if(unsettled.count>0)return fail(res,409,`Close or cancel ${unsettled.count} open order${unsettled.count===1?'':'s'} before closing the shift.`);
  const closedAt=new Date().toISOString();const varianceMinor=countedCashMinor-summary.expectedCashMinor;
  db.transaction(()=>{
    db.prepare(`UPDATE shifts SET status='closed',closed_at=?,close_command_id=?,counted_cash_minor=?,expected_cash_minor=?,variance_minor=? WHERE id=? AND status='open'`)
      .run(closedAt,body.commandId,countedCashMinor,summary.expectedCashMinor,varianceMinor,routeParam(req,'shiftId'));
    audit('shift',routeParam(req,'shiftId'),'shift.closed',null,{countedCashMinor,expectedCashMinor:summary.expectedCashMinor,varianceMinor},currentStaff(res).userId);
    enqueueSyncEvent('shift',routeParam(req,'shiftId'),'shift.closed',{...summary.shift,status:'closed',closedAt,countedCashMinor,
      expectedCashMinor:summary.expectedCashMinor,varianceMinor,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},closedAt);
  })();
  return res.json(shiftSummary(routeParam(req,'shiftId')));
});
}
