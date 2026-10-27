// Local daily sales reports.
import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AddOrderLinesCommand, CashMovementCommand, CreateOrderCommand, KitchenOrder, OrderLine, OrderLineDraft, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage, ShiftRecord, ShiftSummary } from '@common-table/contracts';
import { allocateNumber, createId, db, DATABASE_PATH, DEMO_ACTOR, DEMO_OUTLET, DEMO_TENANT, DEMO_TERMINAL, discardStaleInventoryCount, enqueueSyncEvent, listInventoryCountConflicts, localInventoryBalances, recordManualInventoryMovement, recordPaidOrderInventoryConsumption, syncOutboxStatus } from '../database.js';
import { checkEdgeConfiguration, EDGE_CONFIG } from '../config.js';
import { formatKitchenTicket, formatReceipt, printerStatus, sendToPrinter } from '../printer.js';
import { buildDailySalesReport, buildTableReport, dailySalesCsv, localBusinessDate, tableReportCsv } from '../reports.js';
import { getSyncStatus, syncMenuOnce } from '../sync.js';
import { clearedSessionCookie, createStaffSession, currentStaff, readStaffSession, refreshStaffSession, requireRoles, sessionCookie, StaffAuthError } from '../auth.js';
import { fail, queuePrint, routeParam, mapLines, mapOrder, orderById, mapShift, shiftSummary, kitchenOrders, kitchenSnapshot, refreshOrderKitchenStatus, audit, prepareLines, recalculateOrder, rememberEdit, editReplay, persistAddedLines, createOrder, type PreparedOrderLine } from '../core.js';
import { publish } from '../realtime.js';

export function registerReportRoutes(app:Express){
app.get('/api/reports/daily',requireRoles('owner','manager','viewer'),(req,res)=>{
  const date=typeof req.query.date==='string'?req.query.date:localBusinessDate();
  const report=buildDailySalesReport(date);
  if(!report)return fail(res,400,'Use a valid report date in YYYY-MM-DD format.');
  return res.json(report);
});
app.get('/api/reports/daily.csv',requireRoles('owner','manager','viewer'),(req,res)=>{
  const date=typeof req.query.date==='string'?req.query.date:localBusinessDate();
  const report=buildDailySalesReport(date);
  if(!report)return fail(res,400,'Use a valid report date in YYYY-MM-DD format.');
  res.setHeader('content-type','text/csv; charset=utf-8');
  res.setHeader('content-disposition',`attachment; filename="common-table-${date}.csv"`);
  return res.send(dailySalesCsv(report));
});
app.get('/api/reports/tables',requireRoles('owner','manager','viewer'),(req,res)=>{
  const report=buildTableReport(typeof req.query.date==='string'?req.query.date:localBusinessDate());
  if(!report)return fail(res,400,'Use a valid report date in YYYY-MM-DD format.');
  return res.json(report);
});
app.get('/api/reports/tables.csv',requireRoles('owner','manager','viewer'),(req,res)=>{
  const report=buildTableReport(typeof req.query.date==='string'?req.query.date:localBusinessDate());
  if(!report)return fail(res,400,'Use a valid report date in YYYY-MM-DD format.');
  res.setHeader('content-type','text/csv; charset=utf-8');
  res.setHeader('content-disposition',`attachment; filename="common-table-tables-${report.date}.csv"`);
  return res.send(tableReportCsv(report));
});
}
