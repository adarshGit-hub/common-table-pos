import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddOrderLinesCommand, CashMovementCommand, CreateOrderCommand, KitchenOrder, OrderLine, OrderLineDraft, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage, ShiftRecord, ShiftSummary } from '@common-table/contracts';
import { allocateNumber, createId, db, DATABASE_PATH, DEMO_ACTOR, DEMO_OUTLET, DEMO_TENANT, DEMO_TERMINAL, discardStaleInventoryCount, enqueueSyncEvent, listInventoryCountConflicts, localInventoryBalances, recordManualInventoryMovement, recordPaidOrderInventoryConsumption, syncOutboxStatus } from './database.js';
import { checkEdgeConfiguration, EDGE_CONFIG } from './config.js';
import { formatKitchenTicket, formatReceipt, printerStatus, sendToPrinter, startPrinterAdapter } from './printer.js';
import { buildDailySalesReport, dailySalesCsv, localBusinessDate } from './reports.js';
import { getSyncStatus, startSyncWorker, syncMenuOnce } from './sync.js';
import { clearedSessionCookie, createStaffSession, currentStaff, readStaffSession, readStaffSessionCookie, refreshStaffSession, requireRoles, sessionCookie, sessionMiddleware, StaffAuthError } from './auth.js';
import { startAutomaticBackups } from './automatic-backup.js';

import { registerPublicRoutes } from './routes/public.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerKitchenRoutes } from './routes/kitchen.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerShiftRoutes } from './routes/shifts.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerTableRoutes } from './routes/tables.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerMenuRoutes } from './routes/menu.js';
import { attachRealtime, wss } from './realtime.js';
import { fail } from './core.js';
const app=express();
const httpServer=createServer(app);
const port=Number(process.env.PORT??3001);
app.disable('x-powered-by');
app.use(express.json({limit:'128kb'}));
app.use((req,res,next)=>{
  const supplied=req.header('x-request-id');
  const requestId=supplied&&/^[A-Za-z0-9._-]{8,80}$/.test(supplied)?supplied:randomUUID();
  const startedAt=performance.now();
  res.setHeader('x-request-id',requestId);
  res.on('finish',()=>console.log(JSON.stringify({
    level:res.statusCode>=500?'error':'info',event:'http.request',requestId,method:req.method,
    path:req.path,status:res.statusCode,durationMs:Math.round(performance.now()-startedAt),
  })));
  next();
});

registerPublicRoutes(app);
app.use('/api',sessionMiddleware());
registerSetupRoutes(app);
registerInventoryRoutes(app);
registerKitchenRoutes(app);
registerReportRoutes(app);
registerOrderRoutes(app);
registerTableRoutes(app);
registerBillingRoutes(app);
registerMenuRoutes(app);
registerSystemRoutes(app);
registerShiftRoutes(app);
const webDist=resolve(dirname(fileURLToPath(import.meta.url)),'../../web/dist');
if(existsSync(webDist)){
  app.use(express.static(webDist,{index:false}));
  app.get(/^(?!\/api(?:\/|$)|\/socket(?:\/|$)).*/,(_req,res)=>res.sendFile(resolve(webDist,'index.html')));
}
app.use((_req,res)=>fail(res,404,'Route not found.'));
attachRealtime(httpServer);

const printer=startPrinterAdapter();
const stopSyncWorker=startSyncWorker();
const backupSetting=process.env.POS_AUTO_BACKUP?.trim().toLowerCase();
if(backupSetting!==undefined&&backupSetting!=='true'&&backupSetting!=='false')throw new Error('POS_AUTO_BACKUP must be true or false.');
const backupRetentionDays=Number(process.env.POS_AUTO_BACKUP_RETENTION_DAYS??7);
if(!Number.isSafeInteger(backupRetentionDays)||backupRetentionDays<1||backupRetentionDays>365)throw new Error('POS_AUTO_BACKUP_RETENTION_DAYS must be an integer from 1 to 365.');
const stopAutomaticBackups=backupSetting==='false'||(backupSetting===undefined&&process.env.NODE_ENV!=='production')
  ? async()=>{}
  : startAutomaticBackups({database:db,databasePath:DATABASE_PATH,backupDirectory:resolve(process.env.POS_BACKUP_DIR?.trim()||join(dirname(DATABASE_PATH),'backups')),retentionDays:backupRetentionDays,tenantId:EDGE_CONFIG.tenantId,outletId:EDGE_CONFIG.outletId});
httpServer.listen(port,'0.0.0.0',()=>console.log(`🍽️  Common Table edge server listening on http://0.0.0.0:${port}`));
let shuttingDown=false;
function shutdown(){
  if(shuttingDown)return;
  shuttingDown=true;
  for(const socket of wss.clients)socket.terminate();
  const httpClosed=new Promise<void>(resolve=>httpServer.close(()=>resolve()));
  const webSocketsClosed=new Promise<void>(resolve=>wss.close(()=>resolve()));
  printer?.close();
  void Promise.allSettled([stopSyncWorker(),stopAutomaticBackups(),httpClosed,webSocketsClosed]).finally(()=>db.close());
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);