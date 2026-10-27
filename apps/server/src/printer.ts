import net, { type AddressInfo } from 'node:net';
import type { KitchenOrder, OrderRecord } from '@common-table/contracts';
import { EDGE_CONFIG } from './config.js';

const ESC = 0x1b;
const GS = 0x1d;
const WIDTH = 48;
export type PrinterMode = 'mock' | 'network' | 'disabled';
const configuredMode = process.env.POS_PRINTER_MODE?.trim() as PrinterMode | undefined;
const printerMode: PrinterMode = configuredMode ?? (process.env.NODE_ENV === 'production' ? 'disabled' : 'mock');
if (!['mock', 'network', 'disabled'].includes(printerMode)) throw new Error('POS_PRINTER_MODE must be mock, network, or disabled.');
if (printerMode === 'mock' && process.env.NODE_ENV === 'production') throw new Error('The mock printer is not allowed in production. Configure a network printer or disable printing.');
const printerHost = printerMode === 'network'
  ? process.env.POS_PRINTER_HOST?.trim() ?? ''
  : process.env.MOCK_PRINTER_HOST?.trim() || '127.0.0.1';
const printerPort = Number(printerMode === 'network' ? process.env.POS_PRINTER_PORT ?? 9100 : process.env.MOCK_PRINTER_PORT ?? 9100);
if (printerMode === 'network' && (!printerHost || !Number.isInteger(printerPort) || printerPort < 1 || printerPort > 65535)) {
  throw new Error('Configure POS_PRINTER_HOST and a valid POS_PRINTER_PORT for the network printer.');
}

function line(char='-'): string { return char.repeat(WIDTH); }
function columns(left: string, right: string): string {
  const a = left.slice(0, Math.max(0, WIDTH-right.length-1));
  return `${a}${' '.repeat(Math.max(1,WIDTH-a.length-right.length))}${right}`;
}
function wrap(text: string, width=WIDTH): string[] {
  const words=text.trim().split(/\s+/);const rows:string[]=[];let row='';
  for(const word of words){if(!word)continue;if((row?row.length+1:0)+word.length>width){if(row)rows.push(row);row=word;}else row=row?`${row} ${word}`:word;}
  if(row)rows.push(row);return rows.length?rows:[''];
}
function command(...bytes: number[]): Buffer { return Buffer.from(bytes); }
function text(value: string): Buffer { return Buffer.from(value.replace(/[^\x20-\x7E\n\r]/g,'?'),'ascii'); }
function money(minor: number, currency=EDGE_CONFIG.currency): string { return `${currency === 'INR' ? 'Rs' : currency} ${(minor/100).toFixed(2)}`; }
function readableReceipt(raw:Buffer):string{
  return raw.toString('latin1')
    .replace(/\x1b\x40|\x1b[\x61\x45][\s\S]/g,'')
    .replace(/\x1d\x56[\s\S]{2}/g,'')
    .replace(/[\x00-\x08\x0B-\x1F]/g,'');
}

export function formatKitchenTicket(order: KitchenOrder): Buffer {
  const parts:Buffer[]=[command(ESC,0x40),command(ESC,0x61,1),command(ESC,0x45,1),text(`${EDGE_CONFIG.tenantName}\n${EDGE_CONFIG.outletName}\n`),command(ESC,0x45,0),
    text('KITCHEN ORDER\n'),...(order.tokenNumber?[command(GS,0x21,0x11),text(`TOKEN ${order.tokenNumber}\n`),command(GS,0x21,0)]:[]),command(ESC,0x61,0),text(line('=')+'\n'),text(columns('ORDER',order.orderNumber)+'\n'),
    text(columns(order.orderType==='dine_in'?(order.tableLabel??'DINE IN'):'TAKEAWAY',new Date(order.createdAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:EDGE_CONFIG.timezone}))+'\n'),text(line()+'\n')];
  for(const item of order.lines){parts.push(command(ESC,0x45,1),text(`${item.voidedAt?'VOID ':''}${item.quantity} x ${item.name}\n`),command(ESC,0x45,0));if(item.voidReason)parts.push(text(`    REASON: ${item.voidReason}\n`));if(!item.voidedAt){for(const modifier of item.modifiers)parts.push(text(`    + ${modifier.name}${modifier.priceDeltaMinor?` (${money(modifier.priceDeltaMinor)})`:''}\n`));for(const row of wrap(item.note??''))if(row)parts.push(text(`    ${row}\n`));}}
  if(order.note)parts.push(text(line()+ '\n'),text('NOTE: '+wrap(order.note).join('\n')+'\n'));
  parts.push(text(line('=')+'\n\n'),command(GS,0x56,0x41,0x03));
  return Buffer.concat(parts);
}

/** A pre-payment bill handed to a table; it carries no invoice number and no tenders. */
export function formatBill(order: OrderRecord, defaultSac = ''): Buffer { return formatReceipt(order, [], 'bill', defaultSac); }

export function formatReceipt(order: OrderRecord, tenders: Array<{ method: string; amountMinor: number }> = [], kind: 'receipt'|'bill' = 'receipt', defaultSac = ''): Buffer {
  const receiptName=EDGE_CONFIG.receiptName||EDGE_CONFIG.tenantName;
  const receiptAddress=EDGE_CONFIG.receiptAddress||EDGE_CONFIG.locationLabel;
  const parts:Buffer[]=[command(ESC,0x40),command(ESC,0x61,1),command(ESC,0x45,1),text(`${receiptName}\n${EDGE_CONFIG.outletName}\n`),command(ESC,0x45,0),
    text(`${wrap(receiptAddress).join('\n')}\n`),
    ...(EDGE_CONFIG.receiptPhone?[text(`Phone: ${EDGE_CONFIG.receiptPhone}\n`)]:[]),
    ...(EDGE_CONFIG.gstin?[text(`GSTIN: ${EDGE_CONFIG.gstin}\n`)]:[]),
    text(line('=')+'\n'),...(kind==='receipt'&&EDGE_CONFIG.gstin?[command(ESC,0x61,1),command(ESC,0x45,1),text('TAX INVOICE\n'),command(ESC,0x45,0),command(ESC,0x61,0)]:[]),
    text(kind==='bill'?'BILL - NOT A TAX INVOICE\n':`INVOICE  ${order.invoiceNumber??'PENDING'}\n`),
    text(`ORDER    ${order.orderNumber}\n`),text(`${new Date(order.createdAt).toLocaleString('en-IN',{timeZone:EDGE_CONFIG.timezone})}\n`),
    text(`${order.orderType==='dine_in'?(order.tableLabel??'Dine in'):`Takeaway${order.tokenNumber?` - TOKEN ${order.tokenNumber}`:''}`} - ${order.guestCount} guest(s)\n`),
    ...(order.customer?[text(`Customer: ${order.customer.name??''} ${order.customer.phone.replace(/^(\d+)(\d{4})$/,(_match,head:string,tail:string)=>'x'.repeat(head.length)+tail)}`.replace(/\s+/g,' ').trim()+'\n')]:[]),
    text(line()+'\n')];
  for(const item of order.lines.filter(line=>!line.voidedAt)){parts.push(text(columns(`${item.quantity} x ${item.name}`,money(item.lineTotalMinor,order.currency))+'\n'));for(const modifier of item.modifiers)parts.push(text(`  + ${modifier.name}${modifier.priceDeltaMinor?` (${money(modifier.priceDeltaMinor,order.currency)})`:''}\n`));}
  parts.push(text(line()+'\n'),...((order.pricingVersion??1)>=2?gstTotals(order,defaultSac):legacyTotals(order)),
    command(ESC,0x45,1),text(columns('TOTAL',money(order.totalMinor,order.currency))+'\n'),command(ESC,0x45,0),
    ...(kind==='bill'?[text('Please pay at the counter.\n')]:(tenders.length?tenders:[{method:order.paymentMethod??'cash',amountMinor:order.totalMinor}])
      .map(tender=>text(columns(`Paid - ${tender.method.toUpperCase()}`,money(tender.amountMinor,order.currency))+'\n'))),text(line('=')+'\n'),
    command(ESC,0x61,1),text(`${wrap(EDGE_CONFIG.receiptFooter||'Thank you. See you again!').join('\n')}\n\n`),command(GS,0x56,0x41,0x03));
  return Buffer.concat(parts);
}

/** Totals block for orders priced before the GST bill engine: one tax row per rate. */
function legacyTotals(order: OrderRecord): Buffer[] {
  const taxes=new Map<string,{code:string|null;rate:number;amount:number}>();
  for(const item of order.lines.filter(line=>!line.voidedAt)){
    const rate=item.taxRateBps??order.taxRateBps;const code=item.taxCode??null;const key=`${rate}:${code??''}`;
    const bucket=taxes.get(key)??{code,rate,amount:0};bucket.amount+=Math.round(item.lineTotalMinor*rate/10000);taxes.set(key,bucket);
  }
  const taxRows=[...taxes.values()].sort((a,b)=>a.rate-b.rate||(a.code??'').localeCompare(b.code??''));
  return [text(columns('Subtotal',money(order.subtotalMinor,order.currency))+'\n'),
    ...taxRows.map(bucket=>text(columns(`Tax ${bucket.rate/100}%${bucket.code?` HSN/SAC ${bucket.code}`:''}`,money(bucket.amount,order.currency))+'\n'))];
}

/** GST totals block: discount, service charge, taxable value, CGST/SGST per rate and round-off. */
function gstTotals(order: OrderRecord, defaultSac: string): Buffer[] {
  const amount=(label:string,minor:number)=>text(columns(label,money(minor,order.currency))+'\n');
  const rows:Buffer[]=[amount('Item total',order.subtotalMinor)];
  for(const discount of order.discounts??[])if(discount.appliedMinor){
    const item=discount.lineId?order.lines.find(line=>line.id===discount.lineId)?.name:undefined;
    rows.push(amount(`Discount${discount.kind==='percent'?` ${discount.value/100}%`:''}${item?` (${item})`:''}`,-discount.appliedMinor));
  }
  if(order.serviceChargeMinor)rows.push(amount(`Service charge ${(order.serviceChargeBps??0)/100}%`,order.serviceChargeMinor));
  rows.push(amount('Taxable value',order.subtotalMinor-(order.discountMinor??0)+(order.serviceChargeMinor??0)));
  for(const tax of order.taxLines??[]){
    const code=tax.taxCode??defaultSac;const half=`${tax.taxRateBps/200}%`;
    rows.push(text(`  ${code?`HSN/SAC ${code} - `:''}${tax.taxRateBps/100}% on ${money(tax.taxableMinor,order.currency)}\n`),
      amount(`  CGST ${half}`,tax.cgstMinor),amount(`  SGST ${half}`,tax.sgstMinor));
  }
  if(order.roundOffMinor)rows.push(amount('Round off',order.roundOffMinor));
  return rows;
}

/** One guest's share of a split bill, printed after the single invoice is paid. */
export function formatShareSlip(order: OrderRecord, share: { label: string; method: string; amountMinor: number; lineIds?: string[] }): Buffer {
  const lines=share.lineIds?.length?order.lines.filter(item=>share.lineIds!.includes(item.id)&&!item.voidedAt):[];
  const parts:Buffer[]=[command(ESC,0x40),command(ESC,0x61,1),command(ESC,0x45,1),text('SPLIT BILL SHARE\n'),command(ESC,0x45,0),command(ESC,0x61,0),
    text(line('=')+'\n'),text(columns('INVOICE',order.invoiceNumber??'PENDING')+'\n'),text(columns(share.label,order.tableLabel??'Takeaway')+'\n'),text(line()+'\n')];
  for(const item of lines)parts.push(text(columns(`${item.quantity} x ${item.name}`,money(item.lineTotalMinor,order.currency))+'\n'));
  if(lines.length)parts.push(text('Item prices exclude tax and charges.\n'),text(line()+'\n'));
  parts.push(command(ESC,0x45,1),text(columns(`Paid - ${share.method.toUpperCase()}`,money(share.amountMinor,order.currency))+'\n'),command(ESC,0x45,0),
    text(line('=')+'\n\n'),command(GS,0x56,0x41,0x03));
  return Buffer.concat(parts);
}

export function startMockPrinter(): net.Server {
  if (printerMode !== 'mock') throw new Error('The mock printer is only available when POS_PRINTER_MODE=mock.');
  const server=net.createServer(socket=>{
    const buffers:Buffer[]=[];socket.on('data',chunk=>buffers.push(chunk));socket.on('end',()=>{
      const raw=Buffer.concat(buffers);const printable=readableReceipt(raw);
      console.log(`\n🖨  MOCK 80mm ESC/POS PRINTER · ${raw.length} bytes\n${printable}\n--- paper cut ---\n`);
      socket.end('OK');
    });
  });
  server.on('error',error=>console.error('Mock printer socket error:',error));
  server.listen(printerPort,printerHost,()=>{const addr=server.address() as AddressInfo;console.log(`🖨  Mock ESC/POS printer listening on ${addr.address}:${addr.port}`);});
  return server;
}

export function sendToMockPrinter(payload: Buffer): Promise<void> {
  return sendToPrinter(payload);
}

export function printerStatus(): { mode: PrinterMode; host?: string; port?: number } {
  return printerMode === 'disabled' ? { mode: printerMode } : { mode: printerMode, host: printerHost, port: printerPort };
}

export function startPrinterAdapter(): net.Server | undefined {
  return printerMode === 'mock' ? startMockPrinter() : undefined;
}

export function sendToPrinter(payload: Buffer): Promise<void> {
  if (printerMode === 'disabled') return Promise.reject(new Error('Printer output is disabled on this edge.'));
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:printerHost,port:printerPort});
    let settled=false;
    const finish=(error?:Error)=>{
      if(settled)return;
      settled=true;
      socket.destroy();
      if(error)reject(error);else resolve();
    };
    socket.setTimeout(5000);
    socket.once('connect',()=>socket.end(payload,()=>finish()));
    socket.once('error',error=>finish(error));
    socket.once('timeout',()=>finish(new Error('Printer connection timed out.')));
  });
}
