import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { BarChart3, Download, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import TableReportPanel from './TableReportPanel';
import type { DailySalesReport, OrderRecord, PaymentMethod, ShiftSummary } from '@common-table/contracts';

function businessDate(timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch { return new Date().toISOString().slice(0, 10); }
}

type RefundTender={id:string;method:PaymentMethod;amountMinor:number;refundableMinor:number};
type RefundOrder=Pick<OrderRecord,'id'|'orderNumber'|'totalMinor'|'status'|'invoiceNumber'|'currency'>;

function RefundsPanel({onRefundComplete,currency}:{onRefundComplete:()=>void;currency:string}) {
  const [orders,setOrders]=useState<RefundOrder[]>([]);
  const [orderId,setOrderId]=useState('');
  const [tenders,setTenders]=useState<RefundTender[]>([]);
  const [paymentId,setPaymentId]=useState('');
  const [shift,setShift]=useState<ShiftSummary|null>(null);
  const [amount,setAmount]=useState('');
  const [reason,setReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');

  useEffect(()=>{
    let active=true;
    void Promise.all([fetch('/api/orders',{cache:'no-store'}),fetch('/api/shifts/current',{cache:'no-store'})])
      .then(async([ordersResponse,shiftResponse])=>{
        const [orderRows,shiftPayload]=await Promise.all([ordersResponse.json(),shiftResponse.json()]) as [OrderRecord[],{shift:ShiftSummary|null}];
        if(!ordersResponse.ok||!shiftResponse.ok)throw new Error('Could not load paid orders and the current shift.');
        if(active){const paid=orderRows.filter(order=>order.status==='paid') as RefundOrder[];setOrders(paid);setOrderId(previous=>previous||paid[0]?.id||'');setShift(shiftPayload.shift);}
      }).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:'Could not load refund data.');});
    return()=>{active=false;};
  },[]);

  useEffect(()=>{
    let active=true;
    if(!orderId){setTenders([]);setPaymentId('');return;}
    void fetch(`/api/orders/${encodeURIComponent(orderId)}/payments`,{cache:'no-store'})
      .then(async response=>{const payload=await response.json() as {tenders?:RefundTender[];error?:string};if(!response.ok)throw new Error(payload.error??'Could not load tenders.');return payload;})
      .then(payload=>{if(active){const available=payload.tenders??[];setTenders(available);setPaymentId(previous=>available.some(tender=>tender.id===previous)?previous:available.find(tender=>tender.refundableMinor>0)?.id??'');}})
      .catch(cause=>{if(active)setError(cause instanceof Error?cause.message:'Could not load original tenders.');});
    return()=>{active=false;};
  },[orderId]);

  const tender=tenders.find(row=>row.id===paymentId);
  const selectedOrder=orders.find(order=>order.id===orderId);
  const orderCurrency=selectedOrder?.currency??currency;
  async function submitRefund(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!orderId||!paymentId||!shift||shift.shift.status!=='open')return;
    const amountMinor=Math.round(Number(amount)*100);
    if(!Number.isSafeInteger(amountMinor)||amountMinor<=0||amountMinor>Number(tender?.refundableMinor??0)){setError('Enter a refund amount within the tender’s remaining refundable balance.');return;}
    setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch(`/api/orders/${encodeURIComponent(orderId)}/refunds`,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({commandId:crypto.randomUUID(),paymentId,shiftId:shift.shift.id,amountMinor,reason:reason.trim()})});
      const payload=await response.json() as {refund?:{amountMinor:number};error?:string};
      if(!response.ok)throw new Error(payload.error??'Could not record refund.');
      setAmount('');setReason('');setNotice(`Refund recorded · ${new Intl.NumberFormat('en-IN',{style:'currency',currency:orderCurrency}).format((payload.refund?.amountMinor??amountMinor)/100)}`);
      onRefundComplete();
      const detail=await fetch(`/api/orders/${encodeURIComponent(orderId)}/payments`,{cache:'no-store'});
      if(detail.ok){const values=await detail.json() as {tenders:RefundTender[]};setTenders(values.tenders);}
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not record refund.');}
    finally{setBusy(false);}
  }

  const card='rounded-2xl border border-[#e1e8e1] bg-white p-5 shadow-[0_8px_20px_rgba(25,37,34,.035)]';
  return <section className={`${card} mt-4`}><div className="flex items-center gap-2"><RotateCcw size={15} className="text-[#52765d]"/><h2 className="text-[12px] font-bold">Record a refund</h2></div>
    <p className="mt-1 text-[9px] leading-5 text-[#87948d]">Owner or manager only. Records a manual payout against its original tender; it does not reverse a UPI or card provider transaction.</p>
    {error&&<p role="alert" className="mt-3 rounded-lg border border-[#f1c8c0] bg-[#fff4f1] p-2.5 text-xs text-[#9a493d]">{error}</p>}{notice&&<p role="status" className="mt-3 rounded-lg border border-[#cfe3d2] bg-[#f0f8f1] p-2.5 text-xs text-[#356d49]">{notice}</p>}
    <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={event=>void submitRefund(event)}>
      <label className="text-[9px] font-semibold text-[#718078]">Paid order<select aria-label="Paid order to refund" required value={orderId} onChange={event=>setOrderId(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-[#dfe6e1] bg-white px-2 text-xs" disabled={!orders.length}><option value="">{orders.length?'Choose an order':'No paid orders available'}</option>{orders.map(order=><option key={order.id} value={order.id}>{order.orderNumber} · {order.invoiceNumber??'paid'} · {new Intl.NumberFormat('en-IN',{style:'currency',currency:order.currency}).format(order.totalMinor/100)}</option>)}</select></label>
      <label className="text-[9px] font-semibold text-[#718078]">Original tender<select aria-label="Original tender" required value={paymentId} onChange={event=>setPaymentId(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-[#dfe6e1] bg-white px-2 text-xs" disabled={!tenders.some(row=>row.refundableMinor>0)}><option value="">No refundable tender</option>{tenders.filter(row=>row.refundableMinor>0).map(row=><option key={row.id} value={row.id}>{row.method.toUpperCase()} · remaining {new Intl.NumberFormat('en-IN',{style:'currency',currency:orderCurrency}).format(row.refundableMinor/100)}</option>)}</select></label>
      <label className="text-[9px] font-semibold text-[#718078]">Refund amount ({orderCurrency})<input aria-label="Refund amount" type="number" required min="0.01" step="0.01" max={(Number(tender?.refundableMinor??0)/100).toFixed(2)} value={amount} onChange={event=>setAmount(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-[#dfe6e1] px-2 text-xs"/></label>
      <label className="text-[9px] font-semibold text-[#718078]">Reason<input aria-label="Refund reason" required minLength={3} maxLength={120} value={reason} onChange={event=>setReason(event.target.value)} placeholder="e.g. guest cancelled item" className="mt-1 h-10 w-full rounded-lg border border-[#dfe6e1] px-2 text-xs"/></label>
      <div className="sm:col-span-2"><p className="mb-2 text-[9px] text-[#8a9690]">{shift?.shift.status==='open'?`Assigned to open shift ${shift.shift.shiftNumber}.`:'Open a shift before issuing a refund.'}</p><button className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#286a4f] px-4 text-[10px] font-bold text-white disabled:opacity-50" disabled={busy||!shift||shift.shift.status!=='open'||!tender||!tender.refundableMinor}>{busy?<LoaderCircle size={13} className="animate-spin"/>:<RotateCcw size={13}/>}Record manual refund</button></div>
    </form>
  </section>;
}

export default function ReportsView({ timeZone, currency='INR', canManage=false }: { timeZone?: string | undefined; currency?:string; canManage?:boolean }) {
  const [date, setDate] = useState(() => businessDate(timeZone));
  const [report, setReport] = useState<DailySalesReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshSequence, setRefreshSequence] = useState(0);

  useEffect(() => { setDate(businessDate(timeZone)); }, [timeZone]);

  useEffect(() => {
    if (!date) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void fetch(`/api/reports/daily?date=${encodeURIComponent(date)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const payload = await response.json() as DailySalesReport | { error?: string };
        if (!response.ok) throw new Error('error' in payload ? payload.error : 'Could not load this report.');
        return payload as DailySalesReport;
      })
      .then(setReport)
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load this report.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, refreshSequence]);

  const money = (minor: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: report?.currency ?? currency }).format(minor / 100);
  const card = 'rounded-2xl border border-[#e1e8e1] bg-white p-5 shadow-[0_8px_20px_rgba(25,37,34,.035)]';

  return <section className="mx-auto w-full max-w-[1540px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div><p className="mb-1.5 text-[8px] font-bold tracking-[1px] text-[#87948d]">OUTLET OPERATIONS</p><h1 className="text-[23px] font-bold tracking-[-1px] sm:text-[26px]">Daily report</h1><p className="mt-1 text-[10px] text-[#8a9690]">Local edge sales and shift closeout for the selected business date.</p></div>
      <div className="flex items-center gap-2"><label className="text-[9px] font-semibold text-[#718078]">Business date<input aria-label="Report business date" type="date" value={date} onChange={event => setDate(event.target.value)} className="ml-2 h-9 rounded-lg border border-[#dfe6e1] bg-white px-2 text-[10px] text-[#40564b]"/></label><button type="button" aria-label="Refresh report" onClick={() => setRefreshSequence(value => value + 1)} className="grid size-9 place-items-center rounded-lg border border-[#dfe6e1] bg-white text-[#587060]" title="Refresh report"><RefreshCw size={14}/></button>{report&&<a href={`/api/reports/daily.csv?date=${encodeURIComponent(date)}`} className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#286a4f] px-3 text-[9px] font-bold text-white"><Download size={13}/>Export CSV</a>}</div>
    </header>
    {error&&<div role="alert" className="mb-4 rounded-xl border border-[#f1c8c0] bg-[#fff4f1] px-4 py-3 text-sm text-[#9a493d]">{error}</div>}
    {loading&&!report?<div className="grid min-h-60 place-items-center"><LoaderCircle className="animate-spin text-[#38805a]" size={26}/></div>:report?<>
      <div className="mb-4 flex items-center gap-2 text-[9px] text-[#87948d]"><BarChart3 size={14}/><span>{report.outletName}</span><span>·</span><span>{report.date}</span><span>·</span><span>{report.timeZone}</span><span className="ml-auto">{loading?'Refreshing…':`Updated ${new Date(report.generatedAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}`}</span></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Net sales', money(report.totals.salesMinor), `${report.totals.paidOrderCount} paid orders`],
          ['Tax collected', money(report.totals.taxTotalMinor), 'Tax stored on paid orders'],
          ['Refunds', money(report.refunds.amountMinor), `${report.refunds.count} refund${report.refunds.count===1?'':'s'} recorded`],
          ['Cash variance', money(report.shifts.varianceMinor), `${report.shifts.closedCount} shifts closed`],
          ['Voids', money(report.voids.amountMinor), `${report.voids.lineCount} lines · ${report.voids.quantity} units`],
          ['Discounts', money(report.totals.discountMinor), `Service charge ${money(report.totals.serviceChargeMinor)} · round-off ${money(report.totals.roundOffMinor)}`],
        ].map(([label,value,caption])=><article key={label} className={card}><p className="text-[9px] font-semibold text-[#87948d]">{label}</p><strong className="mt-2 block text-[22px] tracking-[-.6px] text-[#293c31]">{value}</strong><small className="mt-1 block text-[9px] text-[#98a29d]">{caption}</small></article>)}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className={card}><h2 className="mb-3 text-[12px] font-bold">Tender totals</h2>{report.tenders.length?<ul className="divide-y divide-[#edf0ed]">{report.tenders.map(row=><li key={row.method} className="flex justify-between py-2.5 text-[10px]"><span className="capitalize text-[#607168]">{row.method} <small className="ml-1 text-[#98a29d]">{row.paymentCount} payment{row.paymentCount===1?'':'s'}</small></span><strong>{money(row.amountMinor)}</strong></li>)}</ul>:<p className="text-[10px] text-[#98a29d]">No successful tenders recorded.</p>}</section>
        <section className={card}><h2 className="mb-3 text-[12px] font-bold">Tax by configured rate</h2>{report.taxBreakdown.length?<ul className="divide-y divide-[#edf0ed]">{report.taxBreakdown.map(row=><li key={`${row.taxRateBps}:${row.taxCode??''}`} className="flex justify-between py-2.5 text-[10px]"><span className="text-[#607168]">{(row.taxRateBps/100).toFixed(2)}% · {row.taxCode?`HSN/SAC ${row.taxCode}`:'Unclassified'}</span><strong>{money(row.taxMinor)}</strong></li>)}</ul>:<p className="text-[10px] text-[#98a29d]">No paid item tax for this business date.</p>}</section>
        <section className={card}><h2 className="mb-1 text-[12px] font-bold">Item sales</h2><p className="mb-3 text-[9px] text-[#98a29d]">Gross item sales before order-level refunds.</p>{report.items.length?<div className="overflow-x-auto"><table className="w-full text-left text-[10px]"><thead className="text-[8px] uppercase tracking-wide text-[#98a29d]"><tr><th className="pb-2">Item</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Sales</th></tr></thead><tbody className="divide-y divide-[#edf0ed]">{report.items.map(row=><tr key={`${row.menuItemId}:${row.name}`}><td className="py-2 text-[#526259]">{row.name}</td><td className="py-2 text-right">{row.quantity}</td><td className="py-2 text-right font-semibold">{money(row.salesMinor)}</td></tr>)}</tbody></table></div>:<p className="text-[10px] text-[#98a29d]">No paid item sales for this business date.</p>}</section>
      </div>
      <TableReportPanel date={date} refresh={refreshSequence} card={card}/>
      <p className="mt-4 rounded-xl border border-[#efe5ce] bg-[#fffaf0] p-3 text-[9px] leading-5 text-[#8a7857]">This report reads the outlet edge’s local SQLite data. Net sales and tenders subtract recorded refunds; item sales remain gross because refunds are currently recorded against the order, not individual items. Online cloud reports and provider settlements are not connected.</p>
      {canManage&&<RefundsPanel currency={report?.currency??currency} onRefundComplete={()=>setRefreshSequence(value=>value+1)}/>}
    </>:<div className="grid min-h-60 place-items-center rounded-2xl border border-dashed border-[#dfe8e1] bg-white text-[10px] text-[#98a29d]">{error?'Report unavailable':'Loading report…'}</div>}
  </section>;
}
