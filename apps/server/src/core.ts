// Shared order, shift and kitchen helpers used by the route modules.
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AddOrderLinesCommand, CashMovementCommand, CreateOrderCommand, KitchenOrder, OrderLine, OrderLineDraft, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage, ShiftRecord, ShiftSummary } from '@common-table/contracts';
import { allocateNumber, allocateToken, createId, db, DATABASE_PATH, DEMO_ACTOR, DEMO_OUTLET, DEMO_TENANT, DEMO_TERMINAL, discardStaleInventoryCount, enqueueSyncEvent, listInventoryCountConflicts, localInventoryBalances, recordManualInventoryMovement, recordPaidOrderInventoryConsumption, syncOutboxStatus } from './database.js';
import { checkEdgeConfiguration, EDGE_CONFIG } from './config.js';
import { priceBill, roundToMinorFor } from '@common-table/contracts';
import { operationalSettings } from './settings.js';
import type { CustomerInput, CustomerRecord } from '@common-table/contracts';
import { formatKitchenTicket, formatReceipt, printerStatus, sendToPrinter } from './printer.js';
import { buildDailySalesReport, dailySalesCsv, localBusinessDate } from './reports.js';
import { getSyncStatus, syncMenuOnce } from './sync.js';
import { clearedSessionCookie, createStaffSession, currentStaff, readStaffSession, refreshStaffSession, requireRoles, sessionCookie, StaffAuthError } from './auth.js';

export function fail(res:Response,status:number,message:string){return res.status(status).json({error:message});}
export function queuePrint(payload:Buffer,label:string){
  if(printerStatus().mode==='disabled')return;
  void sendToPrinter(payload).catch(error=>console.error(`${label} printer is not reachable:`,error));
}
export function routeParam(req:Request,name:string):string{
  const value=req.params[name];
  return Array.isArray(value)?String(value[0]??''):String(value??'');
}
export function mapLines(orderId:string):OrderLine[]{
  return (db.prepare(`SELECT l.id,l.menu_item_id AS menuItemId,l.item_name_snapshot AS name,l.category_snapshot AS category,
    l.quantity,l.unit_price_minor AS unitPriceMinor,l.modifiers_json AS modifiersJson,l.line_total_minor AS lineTotalMinor,
    l.kitchen_station AS kitchenStation,l.note,l.tax_code_snapshot AS taxCode,l.tax_rate_bps AS taxRateBps,v.voided_at AS voidedAt,v.reason AS voidReason
    FROM order_lines l LEFT JOIN order_line_voids v ON v.order_line_id=l.id WHERE l.order_id=? ORDER BY l.rowid`).all(orderId) as Array<OrderLine & {note:string|null;modifiersJson:string;voidedAt:string|null;voidReason:string|null}>)
    .map(line=>({...line,modifiers:JSON.parse(line.modifiersJson) as OrderLine['modifiers'],note:line.note??undefined,
      ...(line.voidedAt?{voidedAt:line.voidedAt,voidReason:line.voidReason??undefined}:{})}));
}
export function mapOrder(row:Record<string,unknown>):OrderRecord{
  const lines=mapLines(String(row.id));
  return {
    id:String(row.id),commandId:String(row.command_id),tenantId:String(row.tenant_id),outletId:String(row.outlet_id),
    terminalId:String(row.terminal_id),currency:String(row.currency??EDGE_CONFIG.currency),orderNumber:String(row.order_number),orderType:row.order_type as 'dine_in'|'takeaway',
    tableLabel:row.table_label==null?null:String(row.table_label),guestCount:Number(row.guest_count),status:row.status as OrderStatus,
    note:row.note==null?null:String(row.note),createdAt:String(row.created_at),lines,
    taxRateBps:Number(row.tax_rate_bps),subtotalMinor:Number(row.subtotal_minor),taxTotalMinor:Number(row.tax_total_minor),
    totalMinor:Number(row.total_minor),...(row.invoice_number?{invoiceNumber:String(row.invoice_number)}:{}),
    ...(row.payment_method?{paymentMethod:row.payment_method as PaymentMethod}:{}),
    tableId:row.table_id==null?null:String(row.table_id),billPrintedAt:row.bill_printed_at==null?null:String(row.bill_printed_at),
    pricingVersion:Number(row.pricing_version??1),discountMinor:Number(row.discount_minor??0),serviceChargeBps:Number(row.service_charge_bps??0),
    serviceChargeMinor:Number(row.service_charge_minor??0),roundOffMinor:Number(row.round_off_minor??0),
    discounts:activeDiscounts(String(row.id)).map(({id,lineId,kind,value,appliedMinor,reason,createdAt})=>({id,lineId,kind,value,appliedMinor,reason,createdAt})),
    taxLines:orderTaxLines(String(row.id)),
    customer:row.customer_id?customerById(String(row.customer_id))??null:null,tokenNumber:row.token_number==null?null:Number(row.token_number),
  };
}
export function orderById(id:string):OrderRecord|undefined{
  const row=db.prepare('SELECT * FROM orders WHERE id=? AND tenant_id=? AND outlet_id=?').get(id,DEMO_TENANT,DEMO_OUTLET) as Record<string,unknown>|undefined;
  return row?mapOrder(row):undefined;
}
export function mapShift(row:Record<string,unknown>):ShiftRecord{
  return {id:String(row.id),shiftNumber:String(row.shift_number),status:row.status as ShiftRecord['status'],openedAt:String(row.opened_at),openingFloatMinor:Number(row.opening_float_minor),
    ...(row.closed_at?{closedAt:String(row.closed_at)}:{}),...(row.counted_cash_minor!=null?{countedCashMinor:Number(row.counted_cash_minor)}:{}),
    ...(row.expected_cash_minor!=null?{expectedCashMinor:Number(row.expected_cash_minor)}:{}),...(row.variance_minor!=null?{varianceMinor:Number(row.variance_minor)}:{})};
}
export function shiftSummary(shiftId:string):ShiftSummary|undefined{
  const row=db.prepare('SELECT * FROM shifts WHERE id=? AND tenant_id=? AND outlet_id=?').get(shiftId,DEMO_TENANT,DEMO_OUTLET) as Record<string,unknown>|undefined;
  if(!row)return undefined;
  const shift=mapShift(row);
  const salesRows=db.prepare(`SELECT method,SUM(CASE WHEN entry_type='refund' THEN -amount_minor ELSE amount_minor END) AS amount_minor FROM payment_events
    WHERE tenant_id=? AND outlet_id=? AND shift_id=? AND status='succeeded' GROUP BY method`).all(DEMO_TENANT,DEMO_OUTLET,shiftId) as Array<{method:PaymentMethod;amount_minor:number|null}>;
  const salesByMethod:Record<PaymentMethod,number>={cash:0,upi:0,card:0};
  for(const sale of salesRows)salesByMethod[sale.method]=Number(sale.amount_minor??0);
  const movements=db.prepare(`SELECT movement_type,SUM(amount_minor) AS amount_minor FROM cash_movements
    WHERE tenant_id=? AND outlet_id=? AND shift_id=? GROUP BY movement_type`).all(DEMO_TENANT,DEMO_OUTLET,shiftId) as Array<{movement_type:'cash_in'|'cash_out';amount_minor:number|null}>;
  const cashInMinor=Number(movements.find(row=>row.movement_type==='cash_in')?.amount_minor??0);
  const cashOutMinor=Number(movements.find(row=>row.movement_type==='cash_out')?.amount_minor??0);
  const expectedCashMinor=shift.openingFloatMinor+salesByMethod.cash+cashInMinor-cashOutMinor;
  return {shift,salesByMethod,cashInMinor,cashOutMinor,expectedCashMinor};
}
export function kitchenOrders():KitchenOrder[]{
  const rows=db.prepare(`SELECT kt.id AS ticket_id,kt.station AS kitchen_station,kt.status AS ticket_status,o.*
    FROM kitchen_tickets kt JOIN orders o ON o.id=kt.order_id AND o.tenant_id=kt.tenant_id AND o.outlet_id=kt.outlet_id
    WHERE kt.tenant_id=? AND kt.outlet_id=? AND kt.status!='voided' AND o.status IN ('sent','preparing','ready')
    ORDER BY o.created_at,kt.station`)
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  return rows.flatMap(row=>{
    const order=mapOrder(row);const kitchenStation=String(row.kitchen_station);
    const lines=order.lines.filter(line=>line.kitchenStation===kitchenStation);
    if(!lines.some(line=>!line.voidedAt))return [];
    return [{...order,ticketId:String(row.ticket_id),kitchenStation,ticketStatus:row.ticket_status as 'new'|'preparing'|'ready'|'voided',lines}];
  });
}
export function kitchenSnapshot():KitchenOrder[]{
  return kitchenOrders().map(ticket=>({
    id:ticket.id,ticketId:ticket.ticketId??ticket.id,kitchenStation:ticket.kitchenStation??'Unknown station',ticketStatus:ticket.ticketStatus??'new',
    orderNumber:ticket.orderNumber,orderType:ticket.orderType,tableLabel:ticket.tableLabel,status:ticket.status,note:ticket.note,createdAt:ticket.createdAt,tokenNumber:ticket.tokenNumber??null,
    lines:ticket.lines.map(line=>({id:line.id,menuItemId:line.menuItemId,name:line.name,category:line.category,quantity:line.quantity,
      kitchenStation:line.kitchenStation,note:line.note,modifiers:line.modifiers.map(({id,group,name})=>({id,group,name,priceDeltaMinor:0})),voidedAt:line.voidedAt} as OrderLine)),
  }));
}
export function refreshOrderKitchenStatus(orderId:string,timestamp:string){
  const rows=db.prepare(`SELECT kt.status FROM kitchen_tickets kt WHERE kt.tenant_id=? AND kt.outlet_id=? AND kt.order_id=? AND kt.status!='voided'
    AND EXISTS (SELECT 1 FROM order_lines l LEFT JOIN order_line_voids v ON v.order_line_id=l.id
      WHERE l.tenant_id=kt.tenant_id AND l.outlet_id=kt.outlet_id AND l.order_id=kt.order_id AND l.kitchen_station=kt.station AND v.order_line_id IS NULL)`)
    .all(DEMO_TENANT,DEMO_OUTLET,orderId) as Array<{status:'new'|'preparing'|'ready'}>;
  if(!rows.length)return undefined;
  const status=rows.every(row=>row.status==='ready')?'ready':rows.some(row=>row.status==='preparing')?'preparing':'sent';
  db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(status,timestamp,orderId);
  return status;
}
export function audit(entityType:string,entityId:string,action:string,reason:string|null,payload:Record<string,unknown>={},actorId=DEMO_ACTOR){
  const eventId=createId();const occurredAt=new Date().toISOString();
  db.prepare(`INSERT INTO audit_events(id,tenant_id,outlet_id,actor_id,terminal_id,entity_type,entity_id,action,reason,payload_json,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(eventId,DEMO_TENANT,DEMO_OUTLET,actorId,DEMO_TERMINAL,entityType,entityId,action,reason,JSON.stringify(payload),occurredAt);
  enqueueSyncEvent('audit',entityId,action,{entityType,entityId,actorId,terminalId:DEMO_TERMINAL,reason,payload},occurredAt,eventId);
}
export type PreparedOrderLine={id:string;menuItemId:string;name:string;category:string;kitchenStation:string;quantity:number;basePriceMinor:number;modifiers:OrderLine['modifiers'];lineTotalMinor:number;taxCode:string|null;taxRateBps:number;note:string|null};
export function prepareLines(lines:OrderLineDraft[]):PreparedOrderLine[]{
  if(!Array.isArray(lines)||lines.length===0||lines.length>50)throw new Error('An order change needs between 1 and 50 items.');
  return lines.map(line=>{
    const menu=db.prepare('SELECT * FROM menu_items WHERE id=? AND tenant_id=? AND outlet_id=? AND available=1').get(line.menuItemId,DEMO_TENANT,DEMO_OUTLET) as Record<string,unknown>|undefined;
    if(!menu)throw new Error(`Menu item ${line.menuItemId} is unavailable.`);
    if(!Number.isFinite(line.quantity)||line.quantity<=0||line.quantity>99)throw new Error('Item quantities must be between 0 and 99.');
    const quantity=Math.round(line.quantity*1000)/1000;
    const modifierIds=[...new Set(line.modifierIds??[])];
    if(modifierIds.length>(line.modifierIds??[]).length||modifierIds.length>8)throw new Error('Choose valid item modifiers.');
    const modifiers=modifierIds.length?db.prepare(`SELECT id,group_name AS "group",name,price_delta_minor AS priceDeltaMinor FROM menu_modifiers
      WHERE tenant_id=? AND outlet_id=? AND menu_item_id=? AND active=1 AND id IN (${modifierIds.map(()=>'?').join(',')}) ORDER BY sort_order`)
      .all(DEMO_TENANT,DEMO_OUTLET,line.menuItemId,...modifierIds) as OrderLine['modifiers']:[];
    if(modifiers.length!==modifierIds.length)throw new Error(`One or more modifiers for ${String(menu.name)} are no longer available.`);
    const groupCounts=new Map<string,number>();for(const modifier of modifiers)groupCounts.set(modifier.group,(groupCounts.get(modifier.group)??0)+1);
    for(const [group,count] of groupCounts)if(group!=='Add-on'&&count>1)throw new Error(`Select only one ${group.toLowerCase()} option.`);
    const basePriceMinor=Number(menu.price_minor);const unitPriceMinor=basePriceMinor+modifiers.reduce((sum,modifier)=>sum+modifier.priceDeltaMinor,0);
    const taxCode=menu.tax_code==null?null:String(menu.tax_code);
    const taxRateBps=menu.tax_rate_bps==null?EDGE_CONFIG.taxRateBps:Number(menu.tax_rate_bps);
    if(!Number.isSafeInteger(taxRateBps)||taxRateBps<0||taxRateBps>10_000)throw new Error(`Menu item ${String(menu.name)} has an invalid tax rate.`);
    return {id:createId(),menuItemId:String(menu.id),name:String(menu.name),category:String(menu.category),kitchenStation:String(menu.kitchen_station),quantity,basePriceMinor,modifiers,lineTotalMinor:Math.round(unitPriceMinor*quantity),taxCode,taxRateBps,note:line.note?.slice(0,140)??null};
  });
}
export function recalculateOrder(orderId:string,timestamp:string){
  const version=Number((db.prepare('SELECT pricing_version FROM orders WHERE id=?').get(orderId) as {pricing_version:number}|undefined)?.pricing_version??1);
  if(version>=2){repriceOrder(orderId,timestamp);return;}
  const totals=db.prepare(`SELECT COALESCE(SUM(l.line_total_minor),0) AS subtotal,
    COALESCE(SUM(ROUND(l.line_total_minor*l.tax_rate_bps/10000.0)),0) AS tax FROM order_lines l
    LEFT JOIN order_line_voids v ON v.order_line_id=l.id WHERE l.order_id=? AND v.order_line_id IS NULL`).get(orderId) as {subtotal:number;tax:number};
  const subtotal=Number(totals.subtotal);const tax=Number(totals.tax);
  db.prepare('UPDATE orders SET subtotal_minor=?,tax_total_minor=?,total_minor=?,updated_at=? WHERE id=?').run(subtotal,tax,subtotal+tax,timestamp,orderId);
}
export function rememberEdit(commandId:string,orderId:string,action:'lines_added'|'line_voided'|'order_voided',request:unknown,timestamp:string){
  if(editReplay(commandId,orderId,action,request))return true;
  db.prepare('INSERT INTO order_edit_commands(command_id,tenant_id,outlet_id,order_id,action,request_json,occurred_at) VALUES(?,?,?,?,?,?,?)')
    .run(commandId,DEMO_TENANT,DEMO_OUTLET,orderId,action,JSON.stringify(request),timestamp);
  return false;
}
export function editReplay(commandId:string,orderId:string,action:'lines_added'|'line_voided'|'order_voided',request:unknown){
  const previous=db.prepare('SELECT order_id,action,request_json FROM order_edit_commands WHERE command_id=?').get(commandId) as {order_id:string;action:string;request_json:string}|undefined;
  if(!previous)return false;
  if(previous.order_id!==orderId||previous.action!==action||previous.request_json!==JSON.stringify(request))throw new Error('This commandId was already used for a different order change.');
  return true;
}
export function persistAddedLines(orderId:string,lines:PreparedOrderLine[],timestamp:string){
  const insert=db.prepare(`INSERT INTO order_lines(id,tenant_id,outlet_id,order_id,menu_item_id,item_name_snapshot,category_snapshot,unit_price_minor,modifiers_json,quantity,line_total_minor,kitchen_station,note,tax_code_snapshot,tax_rate_bps)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const line of lines)insert.run(line.id,DEMO_TENANT,DEMO_OUTLET,orderId,line.menuItemId,line.name,line.category,line.basePriceMinor,JSON.stringify(line.modifiers),line.quantity,line.lineTotalMinor,line.kitchenStation,line.note,line.taxCode,line.taxRateBps);
  const known=new Set((db.prepare('SELECT station FROM kitchen_tickets WHERE order_id=?').all(orderId) as Array<{station:string}>).map(ticket=>ticket.station));
  const insertTicket=db.prepare(`INSERT INTO kitchen_tickets(id,tenant_id,outlet_id,order_id,station,status,created_at) VALUES(?,?,?,?,?,'new',?)`);
  for(const station of new Set(lines.map(line=>line.kitchenStation))){
    if(known.has(station))db.prepare("UPDATE kitchen_tickets SET status='new',ready_at=NULL WHERE tenant_id=? AND outlet_id=? AND order_id=? AND station=?")
      .run(DEMO_TENANT,DEMO_OUTLET,orderId,station);
    else insertTicket.run(createId(),DEMO_TENANT,DEMO_OUTLET,orderId,station,timestamp);
  }
}
export function createOrder(command:CreateOrderCommand,actorId=DEMO_ACTOR):{order:OrderRecord;duplicate:boolean}{
  const existing=db.prepare('SELECT * FROM orders WHERE command_id=?').get(command.commandId) as Record<string,unknown>|undefined;
  if(existing)return {order:mapOrder(existing),duplicate:true};
  if(command.tenantId!==DEMO_TENANT||command.outletId!==DEMO_OUTLET||command.terminalId!==DEMO_TERMINAL)throw new Error('Unknown demo tenant, outlet, or terminal.');
  if(!Array.isArray(command.lines)||command.lines.length===0||command.lines.length>50)throw new Error('An order needs between 1 and 50 items.');
  if(command.orderType!=='dine_in'&&command.orderType!=='takeaway')throw new Error('Unsupported order type.');
  if(command.orderType==='dine_in'&&!command.tableId&&!command.tableLabel?.trim())throw new Error('Choose a table for dine-in orders.');
  let tableId:string|null=null;let tableLabel:string|null=null;
  if(command.orderType==='dine_in'){
    const table=findTable(command.tableId,command.tableLabel);
    if(table){
      if(activeOrderAtTable(table.id))throw new Error(`${table.name} already has an open order. Add items to it or merge the tables.`);
      tableId=table.id;tableLabel=table.name;
    }else if(command.tableId)throw new Error('Choose a table that exists on this floor.');
    // Orders queued offline by older clients may name a table that no longer exists; keep the label.
    else tableLabel=command.tableLabel!.trim().slice(0,40);
  }
  const customer=command.customer?normalizeCustomer(command.customer):undefined;
  if(typeof customer==='string')throw new Error(customer);
  const prepared=prepareLines(command.lines);
  // Totals are filled in by repriceOrder once the lines exist.
  const subtotalMinor=0;const taxTotalMinor=0;const totalMinor=0;
  const serviceChargeBps=command.orderType==='dine_in'?operationalSettings().serviceChargeBps:0;
  const orderId=randomUUID();const timestamp=new Date().toISOString();
  const create=db.transaction(()=>{
    const orderNumber=allocateNumber('order','ORD');
    db.prepare(`INSERT INTO orders(id,command_id,tenant_id,outlet_id,terminal_id,order_number,order_type,table_id,table_label,guest_count,status,note,currency,subtotal_minor,tax_total_minor,tax_rate_bps,total_minor,created_at,updated_at,pricing_version,service_charge_bps)
      VALUES(@id,@commandId,@tenantId,@outletId,@terminalId,@orderNumber,@orderType,@tableId,@tableLabel,@guestCount,'sent',@note,@currency,@subtotalMinor,@taxTotalMinor,@taxRateBps,@totalMinor,@createdAt,@updatedAt,2,@serviceChargeBps)`).run({
      id:orderId,commandId:command.commandId,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL,orderNumber,
      orderType:command.orderType,tableId,tableLabel,guestCount:Math.max(1,Math.min(20,Math.floor(command.guestCount??1))),
      note:command.note?.slice(0,140)??null,currency:EDGE_CONFIG.currency,subtotalMinor,taxTotalMinor,taxRateBps:EDGE_CONFIG.taxRateBps,totalMinor,createdAt:timestamp,updatedAt:timestamp,serviceChargeBps,
    });
    const insertLine=db.prepare(`INSERT INTO order_lines(id,tenant_id,outlet_id,order_id,menu_item_id,item_name_snapshot,category_snapshot,unit_price_minor,modifiers_json,quantity,line_total_minor,kitchen_station,note,tax_code_snapshot,tax_rate_bps)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const line of prepared)insertLine.run(line.id,DEMO_TENANT,DEMO_OUTLET,orderId,line.menuItemId,line.name,line.category,line.basePriceMinor,JSON.stringify(line.modifiers),line.quantity,line.lineTotalMinor,line.kitchenStation,line.note,line.taxCode,line.taxRateBps);
    const stations=new Set(prepared.map(line=>line.kitchenStation));
    const insertTicket=db.prepare(`INSERT INTO kitchen_tickets(id,tenant_id,outlet_id,order_id,station,status,created_at) VALUES(?,?,?,?,?,'new',?)`);
    for(const station of stations)insertTicket.run(createId(),DEMO_TENANT,DEMO_OUTLET,orderId,station,timestamp);
    repriceOrder(orderId,timestamp);
    if(customer)db.prepare('UPDATE orders SET customer_id=? WHERE id=?').run(upsertCustomer(customer,timestamp),orderId);
    if(command.orderType==='takeaway')db.prepare('UPDATE orders SET token_number=? WHERE id=?').run(allocateToken(localBusinessDate()),orderId);
    audit('order',orderId,'order.sent_to_kitchen',null,{orderNumber,terminalId:DEMO_TERMINAL,lineCount:prepared.length},actorId);
    enqueueSyncEvent('order',orderId,'order.created',{...orderById(orderId)!},timestamp);
  });
  create();
  const order=orderById(orderId)!;
  return {order,duplicate:false};
}
export function orderTenders(orderId:string):Array<{method:PaymentMethod;amountMinor:number}>{
  return (db.prepare(`SELECT method,amount_minor AS amountMinor FROM payment_events WHERE tenant_id=? AND outlet_id=? AND order_id=?
    AND status='succeeded' AND entry_type='tender' ORDER BY created_at,id`).all(DEMO_TENANT,DEMO_OUTLET,orderId) as Array<{method:PaymentMethod;amountMinor:number}>)
    .map(row=>({method:row.method,amountMinor:Number(row.amountMinor)}));
}

export interface TableRow {id:string;areaId:string;name:string;capacity:number;sortOrder:number;active:number}
/** Finds an active table by ID, or by name for clients that only send a label. */
export function findTable(tableId?:string,tableLabel?:string):TableRow|undefined{
  const columns='id,area_id AS areaId,name,capacity,sort_order AS sortOrder,active';
  if(tableId)return db.prepare(`SELECT ${columns} FROM dining_tables WHERE tenant_id=? AND outlet_id=? AND id=? AND active=1`).get(DEMO_TENANT,DEMO_OUTLET,tableId) as TableRow|undefined;
  if(tableLabel?.trim())return db.prepare(`SELECT ${columns} FROM dining_tables WHERE tenant_id=? AND outlet_id=? AND name=? AND active=1`).get(DEMO_TENANT,DEMO_OUTLET,tableLabel.trim()) as TableRow|undefined;
  return undefined;
}
export function activeOrderAtTable(tableId:string):{id:string}|undefined{
  return db.prepare(`SELECT id FROM orders WHERE tenant_id=? AND outlet_id=? AND table_id=? AND status IN ('sent','preparing','ready')`)
    .get(DEMO_TENANT,DEMO_OUTLET,tableId) as {id:string}|undefined;
}

export interface OrderDiscountRow {id:string;lineId:string|null;kind:'percent'|'amount';value:number;appliedMinor:number;reason:string;createdAt:string}
export function activeDiscounts(orderId:string):OrderDiscountRow[]{
  return (db.prepare(`SELECT id,order_line_id AS lineId,kind,value,applied_minor AS appliedMinor,reason,created_at AS createdAt FROM order_discounts
    WHERE tenant_id=? AND outlet_id=? AND order_id=? AND voided_at IS NULL ORDER BY created_at,id`).all(DEMO_TENANT,DEMO_OUTLET,orderId) as OrderDiscountRow[])
    .map(row=>({...row,value:Number(row.value),appliedMinor:Number(row.appliedMinor)}));
}
/** Prices an order with the shared bill engine and stores totals, discount amounts and GST lines. */
export function repriceOrder(orderId:string,timestamp:string){
  const order=db.prepare('SELECT currency,service_charge_bps FROM orders WHERE id=?').get(orderId) as {currency:string;service_charge_bps:number};
  const lines=db.prepare(`SELECT l.id,l.line_total_minor AS lineTotalMinor,l.tax_rate_bps AS taxRateBps,l.tax_code_snapshot AS taxCode FROM order_lines l
    LEFT JOIN order_line_voids v ON v.order_line_id=l.id WHERE l.order_id=? AND v.order_line_id IS NULL ORDER BY l.rowid`).all(orderId) as
    Array<{id:string;lineTotalMinor:number;taxRateBps:number;taxCode:string|null}>;
  const discounts=activeDiscounts(orderId).filter(discount=>!discount.lineId||lines.some(line=>line.id===discount.lineId));
  const bill=priceBill({lines,discounts,serviceChargeBps:Number(order.service_charge_bps),serviceTaxRateBps:EDGE_CONFIG.taxRateBps,
    roundToMinor:roundToMinorFor(order.currency)});
  discounts.forEach((discount,index)=>db.prepare('UPDATE order_discounts SET applied_minor=? WHERE id=?').run(bill.discountAmounts[index]??0,discount.id));
  // Discounts on lines that were voided no longer apply.
  db.prepare(`UPDATE order_discounts SET applied_minor=0 WHERE order_id=? AND voided_at IS NULL AND order_line_id IS NOT NULL
    AND order_line_id IN (SELECT order_line_id FROM order_line_voids WHERE order_id=?)`).run(orderId,orderId);
  db.prepare(`UPDATE orders SET subtotal_minor=?,discount_minor=?,service_charge_minor=?,tax_total_minor=?,round_off_minor=?,total_minor=?,updated_at=? WHERE id=?`)
    .run(bill.subtotalMinor,bill.discountMinor,bill.serviceChargeMinor,bill.taxTotalMinor,bill.roundOffMinor,bill.totalMinor,timestamp,orderId);
  db.prepare('DELETE FROM order_tax_lines WHERE order_id=?').run(orderId);
  const insert=db.prepare('INSERT INTO order_tax_lines(order_id,tax_rate_bps,tax_code,taxable_minor,cgst_minor,sgst_minor) VALUES(?,?,?,?,?,?)');
  for(const line of bill.taxLines)insert.run(orderId,line.taxRateBps,line.taxCode??'',line.taxableMinor,line.cgstMinor,line.sgstMinor);
}
export function orderTaxLines(orderId:string){
  return (db.prepare(`SELECT tax_rate_bps AS taxRateBps,tax_code AS taxCode,taxable_minor AS taxableMinor,cgst_minor AS cgstMinor,sgst_minor AS sgstMinor
    FROM order_tax_lines WHERE order_id=? ORDER BY tax_rate_bps,tax_code`).all(orderId) as Array<{taxRateBps:number;taxCode:string;taxableMinor:number;cgstMinor:number;sgstMinor:number}>)
    .map(row=>({...row,taxCode:row.taxCode||null}));
}

/** Cleans guest details: phone digits only (10-15), optional name; returns an error message when invalid. */
export function normalizeCustomer(input:CustomerInput):{phone:string;name:string|null}|string{
  const phone=typeof input?.phone==='string'?input.phone.replace(/[\s()+-]/g,''):'';
  if(!/^[0-9]{10,15}$/.test(phone))return 'Enter a phone number of 10 to 15 digits.';
  const name=typeof input.name==='string'?input.name.trim().replace(/[\u0000-\u001f\u007f]/g,'').slice(0,80):'';
  return {phone,name:name||null};
}
export function upsertCustomer(customer:{phone:string;name:string|null},timestamp:string):string{
  const existing=db.prepare('SELECT id FROM customers WHERE tenant_id=? AND outlet_id=? AND phone=?').get(DEMO_TENANT,DEMO_OUTLET,customer.phone) as {id:string}|undefined;
  if(existing){
    if(customer.name)db.prepare('UPDATE customers SET name=?,updated_at=? WHERE id=?').run(customer.name,timestamp,existing.id);
    return existing.id;
  }
  const id=createId();
  db.prepare('INSERT INTO customers(id,tenant_id,outlet_id,phone,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,DEMO_TENANT,DEMO_OUTLET,customer.phone,customer.name,timestamp,timestamp);
  return id;
}
export function customerById(id:string):CustomerRecord|undefined{
  return db.prepare('SELECT id,phone,name FROM customers WHERE id=? AND tenant_id=? AND outlet_id=?').get(id,DEMO_TENANT,DEMO_OUTLET) as CustomerRecord|undefined;
}
