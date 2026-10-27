import { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type { OrderRecord } from '@common-table/contracts';
import { formatMoney, newCommandId, sendJson } from './api';

const REASONS = ['Regular customer', 'Staff meal', 'Complaint', 'Festival offer', 'Manager approved'];

/** Adds an item or whole-bill discount to a saved order, or removes an existing one. */
export default function DiscountDialog({ order, limitBps, isManager, onChanged, onClose }: {
  order: OrderRecord; limitBps: number; isManager: boolean; onChanged: (order: OrderRecord) => void; onClose: () => void;
}) {
  const lines = order.lines.filter(line => !line.voidedAt);
  const [lineId, setLineId] = useState('');
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('10');
  const [reason, setReason] = useState(REASONS[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const money = (minor: number) => formatMoney(minor, order.currency);
  const minorValue = kind === 'percent' ? Math.round(Number(value) * 100) : Math.round(Number(value) * 100);

  async function apply() {
    setBusy(true); setError('');
    try {
      onChanged(await sendJson<OrderRecord>(`/api/orders/${order.id}/discounts`, { commandId: newCommandId(), ...(lineId ? { lineId } : {}), kind, value: minorValue, reason }));
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not apply the discount.'); }
    finally { setBusy(false); }
  }
  async function remove(discountId: string) {
    setBusy(true); setError('');
    try { onChanged(await sendJson<OrderRecord>(`/api/orders/${order.id}/discounts/${discountId}/void`, { reason: 'Removed at the counter' })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove the discount.'); }
    finally { setBusy(false); }
  }

  return <div className="fixed inset-0 z-30 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-labelledby="discount-title" className="max-h-[90vh] w-full max-w-[440px] overflow-y-auto rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl">
    <div className="flex items-center justify-between"><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">DISCOUNT · {order.orderNumber}</span><button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div>
    <h2 id="discount-title" className="mt-2 text-lg font-bold">Give a discount</h2>
    {!isManager && <p className="mt-1 text-[10px] text-[#7d8a83]">Cashiers can discount up to {limitBps / 100}% of the bill. Larger discounts need a manager.</p>}
    {!!order.discounts?.length && <ul className="mt-3 divide-y divide-[#edf0ed] rounded-xl border border-[#e8ede9] px-3">{order.discounts.map(discount => <li key={discount.id} className="flex items-center gap-2 py-2 text-[11px]">
      <span className="flex-1">{discount.kind === 'percent' ? `${discount.value / 100}%` : money(discount.value)} {discount.lineId ? `on ${order.lines.find(line => line.id === discount.lineId)?.name ?? 'item'}` : 'on bill'}<small className="block text-[9px] text-[#98a29d]">{discount.reason}</small></span>
      <strong className="text-[#9a493d]">−{money(discount.appliedMinor)}</strong>
      <button type="button" aria-label="Remove discount" disabled={busy} onClick={() => void remove(discount.id)} className="grid size-7 place-items-center rounded-md border border-[#f1d6cf] text-[#9a493d]"><Trash2 size={12}/></button></li>)}</ul>}
    <label className="mt-3 block text-xs font-medium text-[#526259]">Applies to<select value={lineId} onChange={event => setLineId(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[#e5ebe6] px-2 text-xs"><option value="">Whole bill</option>{lines.map(line => <option key={line.id} value={line.id}>{line.quantity} × {line.name} ({money(line.lineTotalMinor)})</option>)}</select></label>
    <div className="mt-3 grid grid-cols-2 gap-2">{(['percent', 'amount'] as const).map(option => <button key={option} type="button" onClick={() => setKind(option)} className={`h-9 rounded-lg border text-xs ${kind === option ? 'border-[#93bba0] bg-[#edf6ef] font-bold text-[#34704c]' : 'border-[#e5ebe6] text-[#5f6f66]'}`}>{option === 'percent' ? 'Percent %' : `Amount ${order.currency}`}</button>)}</div>
    <input aria-label="Discount value" type="number" min="0.01" step="0.01" value={value} onChange={event => setValue(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-[#e5ebe6] px-3 text-sm"/>
    <label className="mt-3 block text-xs font-medium text-[#526259]">Reason<input list="discount-reasons" value={reason} onChange={event => setReason(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[#e5ebe6] px-2 text-xs"/></label>
    <datalist id="discount-reasons">{REASONS.map(option => <option key={option} value={option}/>)}</datalist>
    {error && <p role="alert" className="mt-2 rounded-lg bg-[#fff4f1] p-2 text-xs text-[#9a493d]">{error}</p>}
    <button type="button" disabled={busy || !(minorValue > 0) || reason.trim().length < 3} onClick={() => void apply()} className="mt-4 h-10 w-full rounded-lg bg-[#27694f] text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Apply discount'}</button>
  </section></div>;
}
