import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { OrderRecord, PaymentMethod, PaymentTender } from '@common-table/contracts';
import { formatMoney, newCommandId, sendJson } from './api';

const METHODS: PaymentMethod[] = ['cash', 'upi', 'card'];

/**
 * Splits one saved order between guests: equally, or by who had which item.
 * Each guest pays a labelled tender; the server keeps one invoice and prints a share slip per guest.
 */
export default function SplitBillDialog({ order, shiftId, onPaid, onClose }: {
  order: OrderRecord; shiftId: string; onPaid: (order: OrderRecord) => void; onClose: () => void;
}) {
  const lines = order.lines.filter(line => !line.voidedAt);
  const [mode, setMode] = useState<'equal' | 'items'>('equal');
  const [guests, setGuests] = useState(Math.min(10, Math.max(2, order.guestCount)));
  const [methods, setMethods] = useState<PaymentMethod[]>(() => Array.from({ length: 10 }, () => 'cash'));
  const [owner, setOwner] = useState<Record<string, number>>(() => Object.fromEntries(lines.map(line => [line.id, 0])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const money = (minor: number) => formatMoney(minor, order.currency);

  const shares = useMemo(() => {
    const amounts = Array.from({ length: guests }, () => 0);
    if (mode === 'equal') {
      const base = Math.floor(order.totalMinor / guests);
      amounts.fill(base);
      amounts[guests - 1] = order.totalMinor - base * (guests - 1);
      return amounts.map(amountMinor => ({ amountMinor, lineIds: [] as string[] }));
    }
    // By item: each guest pays their items' share of the bill, so tax and charges split in proportion.
    const subtotals = Array.from({ length: guests }, () => 0);
    const lineIds = Array.from({ length: guests }, () => [] as string[]);
    for (const line of lines) { const guest = Math.min(owner[line.id] ?? 0, guests - 1); subtotals[guest]! += line.lineTotalMinor; lineIds[guest]!.push(line.id); }
    const subtotal = subtotals.reduce((sum, value) => sum + value, 0) || 1;
    let allocated = 0;
    return subtotals.map((value, index) => {
      const amountMinor = index === guests - 1 ? order.totalMinor - allocated : Math.round(order.totalMinor * value / subtotal);
      allocated += amountMinor;
      return { amountMinor, lineIds: lineIds[index]! };
    });
  }, [guests, lines, mode, order.totalMinor, owner]);

  const emptyGuest = mode === 'items' && shares.some(share => share.amountMinor <= 0);

  async function pay() {
    setBusy(true); setError('');
    const tenders: PaymentTender[] = shares.map((share, index) => ({
      method: methods[index] ?? 'cash', amountMinor: share.amountMinor, label: `Guest ${index + 1}`,
      ...(mode === 'items' ? { lineIds: share.lineIds } : {}),
    }));
    try { onPaid(await sendJson<OrderRecord>(`/api/orders/${order.id}/payment`, { commandId: newCommandId(), orderId: order.id, shiftId, tenders })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record the split payment.'); }
    finally { setBusy(false); }
  }

  return <div className="fixed inset-0 z-30 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-labelledby="split-title" className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl">
    <div className="flex items-center justify-between"><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">SPLIT BILL · {order.tableLabel ?? 'TAKEAWAY'}</span><button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div>
    <h2 id="split-title" className="mt-2 text-lg font-bold">Split {money(order.totalMinor)}</h2>
    <div className="mt-3 grid grid-cols-2 gap-2">{(['equal', 'items'] as const).map(option => <button key={option} type="button" onClick={() => setMode(option)} className={`h-9 rounded-lg border text-xs ${mode === option ? 'border-[#93bba0] bg-[#edf6ef] font-bold text-[#34704c]' : 'border-[#e5ebe6] text-[#5f6f66]'}`}>{option === 'equal' ? 'Equally' : 'By item'}</button>)}</div>
    <label className="mt-3 flex items-center justify-between text-xs text-[#526259]">Guests<input aria-label="Number of guests" type="number" min="2" max="10" value={guests} onChange={event => setGuests(Math.min(10, Math.max(2, Number(event.target.value) || 2)))} className="h-9 w-20 rounded-lg border border-[#e5ebe6] px-2 text-xs"/></label>
    {mode === 'items' && <div className="mt-3 divide-y divide-[#edf0ed] rounded-xl border border-[#e8ede9] px-3">{lines.map(line => <div key={line.id} className="flex items-center gap-2 py-2 text-[11px]"><span className="flex-1">{line.quantity} × {line.name}</span><span className="text-[#7d8a83]">{money(line.lineTotalMinor)}</span>
      <select aria-label={`Guest for ${line.name}`} value={Math.min(owner[line.id] ?? 0, guests - 1)} onChange={event => setOwner({ ...owner, [line.id]: Number(event.target.value) })} className="h-8 rounded-lg border border-[#e5ebe6] px-1 text-[11px]">{Array.from({ length: guests }, (_, index) => <option key={index} value={index}>Guest {index + 1}</option>)}</select></div>)}</div>}
    <div className="mt-3 space-y-2">{shares.map((share, index) => <div key={index} className="flex items-center gap-2 rounded-lg bg-[#f4f7f4] px-3 py-2 text-xs"><strong className="w-16">Guest {index + 1}</strong><span className="flex-1 text-[#294437]">{money(share.amountMinor)}</span>
      <select aria-label={`Payment method for guest ${index + 1}`} value={methods[index]} onChange={event => setMethods(methods.map((method, position) => position === index ? event.target.value as PaymentMethod : method))} className="h-8 rounded-lg border border-[#e5ebe6] bg-white px-1 text-[11px]">{METHODS.map(method => <option key={method} value={method}>{method.toUpperCase()}</option>)}</select></div>)}</div>
    {emptyGuest && <p className="mt-2 text-[10px] text-[#9a493d]">Every guest needs at least one item, or reduce the number of guests.</p>}
    {error && <p role="alert" className="mt-2 rounded-lg bg-[#fff4f1] p-2 text-xs text-[#9a493d]">{error}</p>}
    <p className="mt-3 rounded-md bg-[#fcf6eb] p-2 text-[9px] text-[#9b805d]">One invoice is recorded. Each guest gets a share slip. Tenders are recorded manually; no payment provider is called.</p>
    <button type="button" disabled={busy || emptyGuest} onClick={() => void pay()} className="mt-3 h-10 w-full rounded-lg bg-[#27694f] text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Recording…' : `Record ${guests} payments`}</button>
  </section></div>;
}
