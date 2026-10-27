// Kitchen display snapshot and station ticket transitions.
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

export function registerKitchenRoutes(app:Express){
app.get('/api/kitchen',requireRoles('owner','manager','kitchen'),(_req,res)=>res.json(kitchenSnapshot()));
app.patch('/api/orders/:orderId/stations/:station/status',requireRoles('owner','manager','kitchen'),(req,res)=>{
  const nextStatus=(req.body as {status?:unknown}).status;
  if(nextStatus!=='preparing'&&nextStatus!=='ready')return fail(res,400,'Kitchen ticket status must be preparing or ready.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  if(before.status==='paid'||before.status==='cancelled')return fail(res,409,'Paid or cancelled orders cannot be updated by the kitchen.');
  const ticket=db.prepare('SELECT id,status FROM kitchen_tickets WHERE tenant_id=? AND outlet_id=? AND order_id=? AND station=?')
    .get(DEMO_TENANT,DEMO_OUTLET,before.id,routeParam(req,'station')) as {id:string;status:'new'|'preparing'|'ready'|'voided'}|undefined;
  if(!ticket)return fail(res,404,'Kitchen ticket not found for this station.');
  if(ticket.status==='voided')return fail(res,409,'This station ticket no longer has active items.');
  if(ticket.status===nextStatus)return res.json(currentStaff(res).role==='kitchen'?{status:before.status}:before);
  const allowed:Record<string,string[]>={new:['preparing','ready'],preparing:['ready']};
  if(!allowed[ticket.status]?.includes(nextStatus))return fail(res,409,`Cannot move a ${ticket.status} kitchen ticket to ${nextStatus}.`);
  const timestamp=new Date().toISOString();
  db.transaction(()=>{
    db.prepare('UPDATE kitchen_tickets SET status=?,ready_at=? WHERE id=?').run(nextStatus,nextStatus==='ready'?timestamp:null,ticket.id);
    refreshOrderKitchenStatus(before.id,timestamp);
    audit('order',before.id,`order.kitchen_ticket.${nextStatus}`,null,{ticketId:ticket.id,station:routeParam(req,'station')},currentStaff(res).userId);
    enqueueSyncEvent('order',before.id,`order.kitchen_ticket.${nextStatus}`,{orderId:before.id,ticketId:ticket.id,station:routeParam(req,'station'),status:nextStatus},timestamp);
  })();
  const after=orderById(before.id)!;publish('order.updated',after);
  return res.json(currentStaff(res).role==='kitchen'?{status:after.status}:after);
});
}
