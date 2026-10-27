// Order lifecycle, payments, receipts and refunds.
import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AddOrderLinesCommand, CashMovementCommand, CreateOrderCommand, KitchenOrder, OrderLine, OrderLineDraft, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage, ShiftRecord, ShiftSummary } from '@common-table/contracts';
import { allocateNumber, createId, db, DATABASE_PATH, DEMO_ACTOR, DEMO_OUTLET, DEMO_TENANT, DEMO_TERMINAL, discardStaleInventoryCount, enqueueSyncEvent, listInventoryCountConflicts, localInventoryBalances, recordManualInventoryMovement, recordPaidOrderInventoryConsumption, syncOutboxStatus } from '../database.js';
import { checkEdgeConfiguration, EDGE_CONFIG } from '../config.js';
import { formatKitchenTicket, formatReceipt, formatShareSlip, printerStatus, sendToPrinter } from '../printer.js';
import { buildDailySalesReport, dailySalesCsv, localBusinessDate } from '../reports.js';
import { getSyncStatus, syncMenuOnce } from '../sync.js';
import { clearedSessionCookie, createStaffSession, currentStaff, readStaffSession, refreshStaffSession, requireRoles, sessionCookie, StaffAuthError } from '../auth.js';
import { fail, queuePrint, routeParam, mapLines, mapOrder, orderById, mapShift, shiftSummary, kitchenOrders, kitchenSnapshot, refreshOrderKitchenStatus, audit, prepareLines, recalculateOrder, rememberEdit, editReplay, persistAddedLines, createOrder, type PreparedOrderLine } from '../core.js';
import { orderTenders } from '../core.js';
import { publish } from '../realtime.js';
import { operationalSettings } from '../settings.js';

export function registerOrderRoutes(app:Express){
app.get('/api/orders/:orderId',requireRoles('owner','manager','cashier'), (req,res)=>{const order=orderById(routeParam(req,'orderId'));if(!order)return fail(res,404,'Order not found.');return res.json(order);});
app.get('/api/orders',requireRoles('owner','manager','cashier'),(_req,res)=>{
  const rows=db.prepare('SELECT * FROM orders WHERE tenant_id=? AND outlet_id=? ORDER BY created_at DESC LIMIT 100').all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  return res.json(rows.map(mapOrder));
});
app.get('/api/orders/:orderId/payments',requireRoles('owner','manager'),(req,res)=>{
  const orderId=routeParam(req,'orderId');
  if(!orderById(orderId))return fail(res,404,'Order not found.');
  const tenders=db.prepare(`SELECT p.id,p.method,p.amount_minor AS amountMinor,p.created_at AS createdAt,
      p.amount_minor-COALESCE(SUM(r.amount_minor),0) AS refundableMinor
    FROM payment_events p LEFT JOIN payment_events r ON r.tenant_id=p.tenant_id AND r.outlet_id=p.outlet_id
      AND r.refund_of=p.id AND r.status='succeeded' AND r.entry_type='refund'
    WHERE p.tenant_id=? AND p.outlet_id=? AND p.order_id=? AND p.status='succeeded' AND p.entry_type='tender'
    GROUP BY p.id ORDER BY p.created_at,p.id`).all(DEMO_TENANT,DEMO_OUTLET,orderId) as Array<Record<string,unknown>>;
  const refunds=db.prepare(`SELECT id,refund_of AS paymentId,method,amount_minor AS amountMinor,refund_reason AS reason,created_at AS createdAt
    FROM payment_events WHERE tenant_id=? AND outlet_id=? AND order_id=? AND status='succeeded' AND entry_type='refund' ORDER BY created_at,id`)
    .all(DEMO_TENANT,DEMO_OUTLET,orderId) as Array<Record<string,unknown>>;
  return res.json({tenders:tenders.map(row=>({...row,amountMinor:Number(row.amountMinor),refundableMinor:Number(row.refundableMinor)})),refunds});
});
app.post('/api/orders',requireRoles('owner','manager','cashier'),(req:Request,res:Response)=>{
  const body=req.body as Partial<CreateOrderCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for idempotent retries.');
  try{
    const {order,duplicate}=createOrder(body as CreateOrderCommand,currentStaff(res).userId);
    publish(duplicate?'order.updated':'order.created',order);
    if(!duplicate)queuePrint(formatKitchenTicket(order),'KOT');
    return res.status(duplicate?200:201).json(order);
  }catch(error){return fail(res,400,error instanceof Error?error.message:'Unable to create order.');}
});
app.post('/api/orders/:orderId/lines',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as Partial<AddOrderLinesCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for idempotent order edits.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  try{if(editReplay(body.commandId,before.id,'lines_added',{lines:body.lines}))return res.json(before);}catch(error){return fail(res,409,error instanceof Error?error.message:'Invalid idempotency key.');}
  if(before.status==='paid'||before.status==='cancelled')return fail(res,409,'Only unpaid, active orders can be edited.');
  let prepared:PreparedOrderLine[];
  try{prepared=prepareLines(body.lines as OrderLineDraft[]);}catch(error){return fail(res,400,error instanceof Error?error.message:'Invalid order lines.');}
  const timestamp=new Date().toISOString();
  try{
    const duplicate=db.transaction(()=>{
      if(rememberEdit(body.commandId!,before.id,'lines_added',{lines:body.lines},timestamp))return true;
      persistAddedLines(before.id,prepared,timestamp);
      const stations=[...new Set(prepared.map(line=>line.kitchenStation))];
      for(const station of stations)db.prepare("UPDATE kitchen_tickets SET status='new',ready_at=NULL WHERE order_id=? AND station=?").run(before.id,station);
      recalculateOrder(before.id,timestamp);
      refreshOrderKitchenStatus(before.id,timestamp);
      audit('order',before.id,'order.lines_added',null,{commandId:body.commandId,lineIds:prepared.map(line=>line.id),lineCount:prepared.length},currentStaff(res).userId);
      enqueueSyncEvent('order',before.id,'order.lines_added',{...orderById(before.id)!},timestamp);
      return false;
    })();
    const after=orderById(before.id)!;publish('order.updated',after);
    if(!duplicate){const update={...after,lines:after.lines.filter(line=>prepared.some(added=>added.id===line.id))};queuePrint(formatKitchenTicket(update),'KOT update');}
    return res.status(duplicate?200:201).json(after);
  }catch(error){return fail(res,409,error instanceof Error?error.message:'Could not add items to the order.');}
});
app.post('/api/orders/:orderId/lines/:lineId/void',requireRoles('owner','manager'),(req,res)=>{
  const body=req.body as {commandId?:unknown;reason?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for idempotent voids.');
  if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.trim().length>120)return fail(res,400,'Enter a void reason between 3 and 120 characters.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  const reason=body.reason.trim();
  try{if(editReplay(body.commandId,before.id,'line_voided',{lineId:routeParam(req,'lineId'),reason}))return res.json(before);}catch(error){return fail(res,409,error instanceof Error?error.message:'Invalid idempotency key.');}
  if(before.status==='paid'||before.status==='cancelled')return fail(res,409,'Paid or cancelled orders cannot be voided.');
  const line=before.lines.find(candidate=>candidate.id===routeParam(req,'lineId'));if(!line)return fail(res,404,'Order item not found.');
  if(line.voidedAt)return fail(res,409,'This item is already voided.');
  const timestamp=new Date().toISOString();
  try{
    db.transaction(()=>{
      if(rememberEdit(body.commandId as string,before.id,'line_voided',{lineId:line.id,reason},timestamp))return;
      db.prepare('INSERT INTO order_line_voids(order_line_id,tenant_id,outlet_id,order_id,actor_id,reason,voided_at) VALUES(?,?,?,?,?,?,?)')
        .run(line.id,DEMO_TENANT,DEMO_OUTLET,before.id,currentStaff(res).userId,reason,timestamp);
      recalculateOrder(before.id,timestamp);
      const remaining=Number((db.prepare(`SELECT COUNT(*) AS count FROM order_lines l LEFT JOIN order_line_voids v ON v.order_line_id=l.id
        WHERE l.order_id=? AND v.order_line_id IS NULL`).get(before.id) as {count:number}).count);
      if(!remaining){db.prepare("UPDATE orders SET status='cancelled',updated_at=? WHERE id=?").run(timestamp,before.id);db.prepare("UPDATE kitchen_tickets SET status='voided' WHERE order_id=?").run(before.id);}
      else {
        const stationRemaining=Number((db.prepare(`SELECT COUNT(*) AS count FROM order_lines l LEFT JOIN order_line_voids v ON v.order_line_id=l.id
          WHERE l.order_id=? AND l.kitchen_station=? AND v.order_line_id IS NULL`).get(before.id,line.kitchenStation) as {count:number}).count);
        if(!stationRemaining)db.prepare("UPDATE kitchen_tickets SET status='voided',ready_at=NULL WHERE tenant_id=? AND outlet_id=? AND order_id=? AND station=?")
          .run(DEMO_TENANT,DEMO_OUTLET,before.id,line.kitchenStation);
        refreshOrderKitchenStatus(before.id,timestamp);
      }
      audit('order',before.id,'order.line_voided',reason,{lineId:line.id,itemName:line.name,quantity:line.quantity},currentStaff(res).userId);
      enqueueSyncEvent('order',before.id,'order.line_voided',{...orderById(before.id)!},timestamp);
    })();
    const after=orderById(before.id)!;publish('order.updated',after);
    const voidUpdate={...after,lines:[{...line,voidedAt:timestamp,voidReason:reason}]};queuePrint(formatKitchenTicket(voidUpdate),'KOT void');
    return res.json(after);
  }catch(error){return fail(res,409,error instanceof Error?error.message:'Could not void this item.');}
});
app.post('/api/orders/:orderId/void',requireRoles('owner','manager'),(req,res)=>{
  const body=req.body as {commandId?:unknown;reason?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for idempotent voids.');
  if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.trim().length>120)return fail(res,400,'Enter a void reason between 3 and 120 characters.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  const reason=body.reason.trim();
  try{if(editReplay(body.commandId,before.id,'order_voided',{reason}))return res.json(before);}catch(error){return fail(res,409,error instanceof Error?error.message:'Invalid idempotency key.');}
  if(before.status==='paid'||before.status==='cancelled')return fail(res,409,'Paid or already cancelled orders cannot be voided.');
  const remaining=before.lines.filter(line=>!line.voidedAt);if(!remaining.length)return fail(res,409,'This order has no active items to void.');
  const timestamp=new Date().toISOString();
  try{
    db.transaction(()=>{
      if(rememberEdit(body.commandId as string,before.id,'order_voided',{reason},timestamp))return;
      const insert=db.prepare('INSERT INTO order_line_voids(order_line_id,tenant_id,outlet_id,order_id,actor_id,reason,voided_at) VALUES(?,?,?,?,?,?,?)');
      for(const line of remaining)insert.run(line.id,DEMO_TENANT,DEMO_OUTLET,before.id,currentStaff(res).userId,reason,timestamp);
      db.prepare("UPDATE orders SET status='cancelled',subtotal_minor=0,tax_total_minor=0,total_minor=0,updated_at=? WHERE id=?").run(timestamp,before.id);
      db.prepare("UPDATE kitchen_tickets SET status='voided' WHERE order_id=?").run(before.id);
      audit('order',before.id,'order.voided',reason,{lineIds:remaining.map(line=>line.id),lineCount:remaining.length},currentStaff(res).userId);
      enqueueSyncEvent('order',before.id,'order.voided',{...orderById(before.id)!},timestamp);
    })();
    const after=orderById(before.id)!;publish('order.updated',after);
    queuePrint(formatKitchenTicket({...after,lines:remaining.map(line=>({...line,voidedAt:timestamp,voidReason:reason}))}),'KOT void');
    return res.json(after);
  }catch(error){return fail(res,409,error instanceof Error?error.message:'Could not void this order.');}
});
app.patch('/api/orders/:orderId/status',requireRoles('owner','manager'),(req,res)=>{
  const nextStatus=(req.body as {status?:OrderStatus}).status;
  const allowed:Record<string,OrderStatus[]>={sent:['preparing','ready'],preparing:['ready']};
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  if(!nextStatus||!allowed[before.status]?.includes(nextStatus))return fail(res,409,`Cannot move an order from ${before.status} to ${nextStatus??'unknown'}.`);
  const timestamp=new Date().toISOString();
  const update=db.transaction(()=>{
    db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(nextStatus,timestamp,before.id);
    // Only advance active tickets: never revive voided ones or move a ready station back.
    if(nextStatus==='ready')db.prepare("UPDATE kitchen_tickets SET status='ready',ready_at=? WHERE order_id=? AND status IN ('new','preparing')").run(timestamp,before.id);
    else db.prepare("UPDATE kitchen_tickets SET status='preparing' WHERE order_id=? AND status='new'").run(before.id);
    audit('order',before.id,`order.${nextStatus}`,null,{},currentStaff(res).userId);
    enqueueSyncEvent('order',before.id,`order.${nextStatus}`,{...orderById(before.id)!},timestamp);
  });update();
  const after=orderById(before.id)!;publish('order.updated',after);return res.json(after);
});
app.post('/api/orders/:orderId/payment',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as Partial<PaymentCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable payment commandId is required.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  type TenderInput={method?:PaymentMethod|undefined;amountMinor?:number|undefined;label?:string|undefined;lineIds?:string[]|undefined};
  const tenders:Array<TenderInput|undefined>=Array.isArray(body.tenders)?body.tenders:[{method:body.method,amountMinor:body.amountMinor}];
  if(tenders.length<1||tenders.length>10)return fail(res,400,'Choose between one and ten tenders.');
  // Split-bill shares: an optional guest label per tender, optionally tied to that guest's items.
  const activeLineIds=new Set(before.lines.filter(line=>!line.voidedAt).map(line=>line.id));const claimed=new Set<string>();
  for(const tender of tenders){
    if(tender?.label!==undefined&&(typeof tender.label!=='string'||!tender.label.trim()||tender.label.length>40))return fail(res,400,'Each split share label must be 1-40 characters.');
    if(tender?.lineIds!==undefined){
      if(!Array.isArray(tender.lineIds)||tender.lineIds.some(id=>typeof id!=='string'||!activeLineIds.has(id)||claimed.has(id)))return fail(res,400,'Each item can belong to only one split share.');
      for(const id of tender.lineIds)claimed.add(id);
    }
  }
  const payments=tenders.map((tender,index)=>({
    commandId:tenders.length===1?body.commandId:`${body.commandId}:${index+1}`,
    method:tender?.method,amountMinor:tender?.amountMinor,
  }));
  if(payments.some(payment=>!payment.method||!(['cash','upi','card'] as const).includes(payment.method)
    ||!Number.isSafeInteger(payment.amountMinor)||Number(payment.amountMinor)<=0))
    return fail(res,400,'Each tender needs a valid method and a positive amount.');
  const dueCommandIds=payments.map(payment=>payment.commandId);
  const duplicateRows=db.prepare(`SELECT command_id,order_id,entry_type,method,amount_minor FROM payment_events WHERE command_id IN (${dueCommandIds.map(()=>'?').join(',')})`)
    .all(...dueCommandIds) as Array<{command_id:string;order_id:string;entry_type:string;method:PaymentMethod;amount_minor:number}>;
  if(duplicateRows.length){
    if(duplicateRows.some(row=>row.order_id!==before.id||row.entry_type!=='tender'))return fail(res,409,'This payment command was already used for a different order.');
    const same=duplicateRows.length===payments.length&&payments.every(payment=>duplicateRows.some(row=>row.command_id===payment.commandId
      &&row.method===payment.method&&Number(row.amount_minor)===payment.amountMinor));
    if(!same)return fail(res,409,'This payment command was already used for different tender amounts.');
    return res.json(before);
  }
  if(before.status==='paid')return fail(res,409,'This order already has a recorded payment.');
  if(before.status==='cancelled')return fail(res,409,'Cancelled orders cannot be paid.');
  if(payments.reduce((sum,payment)=>sum+Number(payment.amountMinor),0)!==before.totalMinor)return fail(res,409,'Tender amounts must add up to the order total.');
  if(typeof body.shiftId!=='string')return fail(res,409,'Open a shift before recording payment.');
  const shift=db.prepare("SELECT id FROM shifts WHERE id=? AND tenant_id=? AND outlet_id=? AND status='open'").get(body.shiftId,DEMO_TENANT,DEMO_OUTLET);
  if(!shift)return fail(res,409,'This payment must be assigned to an open shift.');
  const timestamp=new Date().toISOString();
  const paymentIds=payments.map(()=>createId());
  let invoiceNumber='';
  const pay=db.transaction(()=>{
    invoiceNumber=allocateNumber('invoice','INV');
    const insert=db.prepare('INSERT INTO payment_events(id,command_id,tenant_id,outlet_id,order_id,terminal_id,method,amount_minor,status,shift_id,created_at) VALUES(?,?,?,?,?,?,?,? ,\'succeeded\',?,?)');
    payments.forEach((payment,index)=>{
      const paymentId=paymentIds[index]!;
      insert.run(paymentId,payment.commandId,DEMO_TENANT,DEMO_OUTLET,before.id,DEMO_TERMINAL,payment.method,payment.amountMinor,body.shiftId,timestamp);
      enqueueSyncEvent('payment',paymentId,'payment.recorded',{id:paymentId,commandId:payment.commandId,batchCommandId:body.commandId,orderId:before.id,
        shiftId:body.shiftId,method:payment.method,amountMinor:payment.amountMinor,status:'succeeded',invoiceNumber,createdAt:timestamp,
        tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},timestamp);
    });
    recordPaidOrderInventoryConsumption(before.id,before.orderNumber,currentStaff(res).userId,timestamp);
    const singleMethod=payments.every(payment=>payment.method===payments[0]?.method)?payments[0]?.method:null;
    db.prepare('UPDATE orders SET status=\'paid\',payment_method=?,invoice_number=?,updated_at=? WHERE id=?').run(singleMethod,invoiceNumber,timestamp,before.id);
    audit('order',before.id,'order.payment_recorded',null,{payments:payments.map(({method,amountMinor})=>({method,amountMinor})),invoiceNumber,amountMinor:before.totalMinor,shiftId:body.shiftId},currentStaff(res).userId);
  });pay();
  const order=orderById(before.id)!;publish('order.updated',order);
  queuePrint(formatReceipt(order,orderTenders(order.id),'receipt',operationalSettings().defaultSac),'Receipt');
  for(const tender of tenders)if(tender?.label)queuePrint(formatShareSlip(order,{label:tender.label.trim(),method:String(tender.method),amountMinor:Number(tender.amountMinor),...(tender.lineIds?{lineIds:tender.lineIds}:{})}),'Split share');
  return res.json(order);
});
app.post('/api/orders/:orderId/receipt/reprint',requireRoles('owner','manager','cashier'),async(req,res)=>{
  const body=req.body as {reason?:unknown};
  if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.trim().length>120)
    return fail(res,400,'Enter a reprint reason between 3 and 120 characters.');
  const order=orderById(routeParam(req,'orderId'));
  if(!order)return fail(res,404,'Order not found.');
  if(order.status!=='paid'||!order.invoiceNumber)return fail(res,409,'Only paid orders with an invoice can be reprinted.');
  const printer=printerStatus();
  if(printer.mode==='disabled')return fail(res,503,'Printer output is disabled on this edge.');
  const actor=currentStaff(res);
  audit('receipt',order.id,'receipt.reprint_requested',body.reason.trim(),
    {orderNumber:order.orderNumber,invoiceNumber:order.invoiceNumber,printerMode:printer.mode},actor.userId);
  try{
    await sendToPrinter(formatReceipt(order,orderTenders(order.id),'receipt',operationalSettings().defaultSac));
    audit('receipt',order.id,'receipt.reprint_dispatched',body.reason.trim(),
      {orderNumber:order.orderNumber,invoiceNumber:order.invoiceNumber,printerMode:printer.mode},actor.userId);
    return res.json({status:'dispatched',invoiceNumber:order.invoiceNumber,printerMode:printer.mode});
  }catch(error){
    audit('receipt',order.id,'receipt.reprint_failed',body.reason.trim(),
      {orderNumber:order.orderNumber,invoiceNumber:order.invoiceNumber,printerMode:printer.mode,
        error:error instanceof Error?error.message:'Printer connection failed.'},actor.userId);
    return fail(res,502,'The receipt could not be sent to the printer. Check the printer connection and retry.');
  }
});
app.post('/api/orders/:orderId/refunds',requireRoles('owner','manager'),(req,res)=>{
  const body=req.body as {commandId?:unknown;paymentId?:unknown;shiftId?:unknown;amountMinor?:unknown;reason?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8||body.commandId.length>160)return fail(res,400,'A stable refund commandId is required.');
  if(typeof body.paymentId!=='string'||body.paymentId.length<1||body.paymentId.length>120)return fail(res,400,'Choose the original tender to refund.');
  if(!Number.isSafeInteger(body.amountMinor)||Number(body.amountMinor)<=0)return fail(res,400,'Refund amount must be a positive whole number of minor currency units.');
  if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.trim().length>120)return fail(res,400,'Enter a refund reason between 3 and 120 characters.');
  if(typeof body.shiftId!=='string'||body.shiftId.length<1||body.shiftId.length>120)return fail(res,409,'Open a shift before recording a refund.');
  const orderId=routeParam(req,'orderId');
  const before=orderById(orderId);if(!before)return fail(res,404,'Order not found.');
  if(before.status!=='paid')return fail(res,409,'Only paid orders can be refunded.');
  const duplicate=db.prepare(`SELECT id,order_id,refund_of,amount_minor,refund_reason,method,shift_id,created_at
    FROM payment_events WHERE command_id=? AND tenant_id=? AND outlet_id=?`).get(body.commandId,DEMO_TENANT,DEMO_OUTLET) as {
      id:string;order_id:string;refund_of:string|null;amount_minor:number;refund_reason:string|null;method:PaymentMethod;shift_id:string|null;created_at:string
    }|undefined;
  if(duplicate){
    if(duplicate.order_id!==orderId||duplicate.refund_of!==body.paymentId||Number(duplicate.amount_minor)!==body.amountMinor
      ||duplicate.refund_reason!==body.reason.trim()||duplicate.shift_id!==body.shiftId)
      return fail(res,409,'This refund command was already used for different details.');
    return res.json({order:before,refund:{id:duplicate.id,commandId:String(body.commandId),paymentId:duplicate.refund_of,
      shiftId:duplicate.shift_id,method:duplicate.method,amountMinor:Number(duplicate.amount_minor),reason:duplicate.refund_reason,
      status:'succeeded',createdAt:duplicate.created_at}});
  }
  const original=db.prepare(`SELECT id,method,amount_minor FROM payment_events
    WHERE id=? AND tenant_id=? AND outlet_id=? AND order_id=? AND status='succeeded' AND entry_type='tender'`)
    .get(body.paymentId,DEMO_TENANT,DEMO_OUTLET,orderId) as {id:string;method:PaymentMethod;amount_minor:number}|undefined;
  if(!original)return fail(res,404,'Original successful tender not found for this order.');
  const shift=db.prepare("SELECT id FROM shifts WHERE id=? AND tenant_id=? AND outlet_id=? AND status='open'")
    .get(body.shiftId,DEMO_TENANT,DEMO_OUTLET);
  if(!shift)return fail(res,409,'Refunds must be assigned to an open shift.');
  const refunded=db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS amount_minor FROM payment_events
    WHERE tenant_id=? AND outlet_id=? AND refund_of=? AND status='succeeded' AND entry_type='refund'`)
    .get(DEMO_TENANT,DEMO_OUTLET,original.id) as {amount_minor:number};
  if(Number(body.amountMinor)>Number(original.amount_minor)-Number(refunded.amount_minor))return fail(res,409,'Refund exceeds the remaining refundable amount for this tender.');
  const timestamp=new Date().toISOString();const refundId=createId();const actor=currentStaff(res);
  const refund={id:refundId,commandId:body.commandId,paymentId:original.id,shiftId:String(body.shiftId),method:original.method,
    amountMinor:Number(body.amountMinor),reason:body.reason.trim(),status:'succeeded',createdAt:timestamp};
  const record=db.transaction(()=>{
    db.prepare(`INSERT INTO payment_events(id,command_id,tenant_id,outlet_id,order_id,terminal_id,method,amount_minor,status,shift_id,entry_type,refund_of,refund_reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,'succeeded',?,'refund',?,?,?)`).run(refundId,body.commandId,DEMO_TENANT,DEMO_OUTLET,orderId,DEMO_TERMINAL,
      original.method,body.amountMinor,body.shiftId,original.id,refund.reason,timestamp);
    audit('payment',refundId,'payment.refunded',refund.reason,{...refund,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},actor.userId);
    enqueueSyncEvent('payment',refundId,'payment.refunded',{...refund,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},timestamp);
  });
  try{record();}catch(error){if(error instanceof Error&&/UNIQUE constraint failed: payment_events.command_id/.test(error.message))return fail(res,409,'This refund command was already used. Retry with its original details.');throw error;}
  return res.status(201).json({order:before,refund});
});
}
