// Manager inventory movements and count conflicts.
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

export function registerInventoryRoutes(app:Express){
app.get('/api/inventory',requireRoles('owner','manager'),(_req,res)=>res.json(localInventoryBalances().map(item=>({...item,active:Boolean(item.active),lowStock:Boolean(item.lowStock)}))));
app.post('/api/inventory/movements',requireRoles('owner','manager'),(req,res)=>{
  const body=req.body as Record<string,unknown>;
  const movementType=body.movementType;
  const quantity=Number(body.quantity);
  const expectedBalance=body.expectedBalance===null?null:Number(body.expectedBalance);
  const reason=typeof body.reason==='string'?body.reason.trim():'';
  if(typeof body.commandId!=='string'||body.commandId.trim().length<8||body.commandId.length>160
    ||typeof body.inventoryItemId!=='string'||body.inventoryItemId.length>120
    ||!['receipt','waste','count_adjustment'].includes(String(movementType))
    ||!Number.isFinite(quantity)||quantity<0||quantity>1_000_000_000||Math.round(quantity*1000)!==quantity*1000
    ||(movementType!=='count_adjustment'&&quantity<=0)
    ||(movementType==='count_adjustment'&&(expectedBalance===null||!Number.isFinite(expectedBalance)||Math.abs(expectedBalance)>1_000_000_000))
    ||(movementType!=='count_adjustment'&&body.expectedBalance!==null)
    ||reason.length<3||reason.length>120||/[\u0000-\u001f\u007f]/.test(reason))
    return fail(res,400,'Enter a valid inventory item, movement, quantity, and reason.');
  try{
    const result=recordManualInventoryMovement({commandId:body.commandId.trim(),inventoryItemId:body.inventoryItemId,
      movementType:movementType as 'receipt'|'waste'|'count_adjustment',quantity,expectedBalance,reason,
      actorId:currentStaff(res).userId,occurredAt:new Date().toISOString()});
    const inventory=localInventoryBalances().map(item=>({...item,active:Boolean(item.active),lowStock:Boolean(item.lowStock)}));
    return res.status(result.duplicate?200:201).json({movementId:result.movementId,duplicate:result.duplicate,inventory});
  }catch(error){return fail(res,409,error instanceof Error?error.message:'Could not record inventory movement.');}
});
app.get('/api/inventory/conflicts',requireRoles('owner','manager'),(_req,res)=>res.json(listInventoryCountConflicts()));
app.post('/api/inventory/conflicts/:movementId/discard',requireRoles('owner','manager'),async(req,res)=>{
  const movementId=routeParam(req,'movementId');
  if(!/^[0-9a-f-]{36}$/i.test(movementId))return fail(res,400,'Choose a valid conflicted count.');
  const body=req.body as Record<string,unknown>;
  const reason=typeof body.reason==='string'?body.reason.trim():'';
  if(reason.length<3||reason.length>120||/[\u0000-\u001f\u007f]/.test(reason))return fail(res,400,'Enter a reason between 3 and 120 characters.');
  if(!await syncMenuOnce())return fail(res,503,'Could not refresh the cloud stock balance. Reconnect and try again; the count was not changed.');
  try{
    discardStaleInventoryCount(movementId,currentStaff(res).userId,reason,new Date().toISOString());
    return res.json({inventory:localInventoryBalances().map(item=>({...item,active:Boolean(item.active),lowStock:Boolean(item.lowStock)})),conflicts:listInventoryCountConflicts()});
  }catch(error){return fail(res,409,error instanceof Error?error.message:'Could not resolve the stale count.');}
});
}
