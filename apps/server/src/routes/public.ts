// Unauthenticated health, context and staff session routes.
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

export function registerPublicRoutes(app:Express){
app.get('/api/health',(_req,res)=>res.json({status:'ok',service:'common-table-edge',outletId:DEMO_OUTLET,taxRateBps:EDGE_CONFIG.taxRateBps,printer:printerStatus()}));
app.get('/api/context',(_req,res)=>res.json({
  tenantId:DEMO_TENANT,tenantName:EDGE_CONFIG.tenantName,outletId:DEMO_OUTLET,outletName:EDGE_CONFIG.outletName,
  terminalId:DEMO_TERMINAL,terminalName:EDGE_CONFIG.terminalName,locationLabel:EDGE_CONFIG.locationLabel,
  currency:EDGE_CONFIG.currency,timeZone:EDGE_CONFIG.timezone,taxRateBps:EDGE_CONFIG.taxRateBps,setupMode:setupMode(),
  receipt:{name:EDGE_CONFIG.receiptName,address:EDGE_CONFIG.receiptAddress,phone:EDGE_CONFIG.receiptPhone,gstin:EDGE_CONFIG.gstin,footer:EDGE_CONFIG.receiptFooter},
}));
app.get('/api/ready',(_req,res)=>{
  try{
    checkEdgeConfiguration();
    const databaseCheck=db.prepare('PRAGMA quick_check').get() as {quick_check?:string};
    if(databaseCheck.quick_check!=='ok')return res.status(503).json({status:'not_ready',checks:{database:'failed',configuration:'ok'}});
    db.prepare('SELECT 1').get();
    return res.json({status:'ready',checks:{database:'ok',configuration:'ok'}});
  }catch(error){
    console.error(JSON.stringify({level:'error',event:'readiness.failed',reason:error instanceof Error?error.message:'unknown'}));
    return res.status(503).json({status:'not_ready',checks:{database:'unknown',configuration:'failed'}});
  }
});
app.get('/api/auth/session',(req,res)=>{
  let session=readStaffSession(req);
  if(!session&&process.env.NODE_ENV!=='production'){
    session=currentStaff(res);
    res.setHeader('Set-Cookie',sessionCookie(session,EDGE_CONFIG.secureSessionCookie));
  }
  if(!session)return fail(res,401,'Sign in to this outlet before continuing.');
  const refreshed=refreshStaffSession(session);
  if(refreshed!==session){session=refreshed;res.setHeader('Set-Cookie',sessionCookie(session,EDGE_CONFIG.secureSessionCookie));}
  return res.json({userId:session.userId,email:session.email,displayName:session.displayName,role:session.role,tenantId:session.tenantId,outletId:session.outletId,expiresAt:session.expiresAt});
});
app.post('/api/auth/session',async(req,res)=>{
  const authorization=req.header('authorization')??'';
  const accessToken=authorization.startsWith('Bearer ')?authorization.slice(7).trim():'';
  if(!accessToken)return fail(res,401,'A Supabase sign-in token is required.');
  try{
    const session=await createStaffSession(accessToken);
    res.setHeader('Set-Cookie',sessionCookie(session,EDGE_CONFIG.secureSessionCookie));
    return res.json({userId:session.userId,email:session.email,displayName:session.displayName,role:session.role,tenantId:session.tenantId,outletId:session.outletId,expiresAt:session.expiresAt});
  }catch(error){
    const authError=error instanceof StaffAuthError?error:new StaffAuthError('Could not verify this staff session.',503);
    if(authError.status===403)res.setHeader('Set-Cookie',clearedSessionCookie(EDGE_CONFIG.secureSessionCookie));
    return fail(res,authError.status,authError.message);
  }
});
app.delete('/api/auth/session',(_req,res)=>{
  res.setHeader('Set-Cookie',clearedSessionCookie(EDGE_CONFIG.secureSessionCookie));
  return res.status(204).end();
});
}
