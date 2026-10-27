import { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, Combine, LoaderCircle, Plus, ReceiptText, Users, X } from 'lucide-react';
import type { FloorTableView, FloorView } from '@common-table/contracts';
import { formatMoney, getJson, newCommandId, sendJson } from './api';

const STATUS_STYLE: Record<FloorTableView['status'], { label: string; card: string; dot: string }> = {
  free: { label: 'Free', card: 'border-[#dfe8e1] bg-white', dot: 'bg-[#b9c7be]' },
  occupied: { label: 'Occupied', card: 'border-[#e9cf9f] bg-[#fffaf0]', dot: 'bg-[#d79543]' },
  ready: { label: 'Ready to serve', card: 'border-[#9ccbab] bg-[#eef8f1]', dot: 'bg-[#3f9a62]' },
  bill_printed: { label: 'Bill printed', card: 'border-[#b8c6e6] bg-[#f2f5fc]', dot: 'bg-[#5a74b8]' },
};

function minutesSince(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

type Action = { kind: 'move' | 'merge'; table: FloorTableView };

/** Live table grid: start or open an order, print a bill, move or merge tables. */
export default function FloorPage({ liveTick, onStartOrder, onOpenOrder, notify }: {
  liveTick: number;
  onStartOrder: (table: FloorTableView) => void;
  onOpenOrder: (orderId: string) => void;
  notify: (message: string) => void;
}) {
  const [floor, setFloor] = useState<FloorView | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [action, setAction] = useState<Action | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setFloor(await getJson<FloorView>('/api/floor')); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load the floor.'); }
  }, []);
  useEffect(() => { void load(); }, [load, liveTick]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);

  const money = (minor: number) => formatMoney(minor, floor?.currency);
  const tables = floor?.areas.flatMap(area => area.tables.map(table => ({ ...table, areaName: area.name }))) ?? [];
  const counts = { free: 0, occupied: 0, ready: 0, bill_printed: 0 };
  for (const table of tables) counts[table.status] += 1;

  async function printBill(table: FloorTableView) {
    if (!table.order) return;
    try { await sendJson(`/api/orders/${table.order.id}/bill`, {}); notify(`Bill printed for ${table.name}`); void load(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not print the bill.'); }
  }

  async function submitAction() {
    if (!action?.table.order || !target) return;
    setBusy(true);
    try {
      if (action.kind === 'move') {
        await sendJson(`/api/orders/${action.table.order.id}/move`, { commandId: newCommandId(), tableId: target, reason });
        notify(`${action.table.name} moved`);
      } else {
        await sendJson(`/api/orders/${action.table.order.id}/merge`, { commandId: newCommandId(), targetOrderId: target, reason });
        notify(`${action.table.name} merged`);
      }
      setAction(null); void load();
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not update the tables.'); }
    finally { setBusy(false); }
  }

  const choices = action ? tables.filter(table => table.id !== action.table.id && (action.kind === 'move' ? table.status === 'free' : table.order)) : [];

  return <section className="mx-auto w-full max-w-[1540px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div><p className="mb-1.5 text-[8px] font-bold tracking-[1px] text-[#87948d]">DINING ROOM</p><h1 className="text-[23px] font-bold tracking-[-1px] sm:text-[26px]">Floor</h1><p className="mt-1 text-[10px] text-[#8a9690]">Every table at a glance. Tap a table to take or open its order.</p></div>
      <div className="flex flex-wrap gap-2 text-[9px]">{(Object.keys(STATUS_STYLE) as Array<FloorTableView['status']>).map(status => <span key={status} className="flex items-center gap-1.5 rounded-full border border-[#e3e9e4] bg-white px-2.5 py-1 text-[#5f6f66]"><span className={`size-2 rounded-full ${STATUS_STYLE[status].dot}`}/>{STATUS_STYLE[status].label} <strong>{counts[status]}</strong></span>)}</div>
    </header>
    {error && <div role="alert" className="mb-4 rounded-xl border border-[#f1c8c0] bg-[#fff4f1] px-4 py-3 text-sm text-[#9a493d]">{error}</div>}
    {!floor ? <div className="grid min-h-60 place-items-center"><LoaderCircle className="animate-spin text-[#38805a]" size={26}/></div>
      : !tables.length ? <div className="grid min-h-60 place-items-center rounded-2xl border border-dashed border-[#dfe8e1] bg-white p-6 text-center text-[11px] text-[#8c9891]">No tables yet. {floor.setupMode === 'standalone' ? 'A manager can add areas and tables on the Tables page.' : 'Add tables in the cloud portal.'}</div>
      : floor.areas.filter(area => area.tables.length).map(area => <section key={area.id} className="mb-6">
        <h2 className="mb-2 text-[11px] font-bold text-[#405149]">{area.name} <span className="font-normal text-[#98a29d]">· {area.tables.length} tables</span></h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6">
          {area.tables.map(table => {
            const style = STATUS_STYLE[table.status];
            return <article key={table.id} className={`flex min-h-[128px] flex-col rounded-2xl border p-3 ${style.card}`}>
              <button type="button" onClick={() => table.order ? onOpenOrder(table.order.id) : onStartOrder(table)} className="flex flex-1 flex-col text-left" aria-label={`${table.name}, ${style.label}`}>
                <div className="flex items-center justify-between"><strong className="text-[14px] tracking-[-.3px] text-[#283b31]">{table.name}</strong><span className={`size-2.5 rounded-full ${style.dot}`}/></div>
                <span className="mt-0.5 text-[9px] text-[#7d8a83]">{style.label}</span>
                {table.order ? <div className="mt-auto pt-2 text-[10px] text-[#526259]">
                  <div className="flex items-center gap-1"><Users size={11}/>{table.order.guestCount} of {table.capacity} seats</div>
                  <div className="mt-0.5 flex justify-between"><span>{minutesSince(table.order.createdAt, now)}</span><strong className="text-[#283b31]">{money(table.order.totalMinor)}</strong></div>
                </div> : <div className="mt-auto flex items-center gap-1 pt-2 text-[10px] text-[#7d8a83]"><Plus size={12}/>{table.capacity} seats · start order</div>}
              </button>
              {table.order && <div className="mt-2 flex gap-1 border-t border-black/5 pt-2">
                <button type="button" title="Print bill" onClick={() => void printBill(table)} className="grid h-7 flex-1 place-items-center rounded-md bg-white/80 text-[#40564b] hover:bg-white"><ReceiptText size={13}/></button>
                <button type="button" title="Move to another table" onClick={() => { setAction({ kind: 'move', table }); setTarget(''); setReason('Guests changed tables'); }} className="grid h-7 flex-1 place-items-center rounded-md bg-white/80 text-[#40564b] hover:bg-white"><ArrowRightLeft size={13}/></button>
                <button type="button" title="Merge into another table" onClick={() => { setAction({ kind: 'merge', table }); setTarget(''); setReason('Party seated together'); }} className="grid h-7 flex-1 place-items-center rounded-md bg-white/80 text-[#40564b] hover:bg-white"><Combine size={13}/></button>
              </div>}
            </article>;
          })}
        </div>
      </section>)}
    {action && <div className="fixed inset-0 z-30 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-labelledby="table-action-title" className="w-full max-w-[420px] rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl">
      <div className="flex items-center justify-between"><span className="text-[8px] font-bold tracking-[1.2px] text-[#84918a]">TABLE {action.kind === 'move' ? 'MOVE' : 'MERGE'}</span><button onClick={() => setAction(null)} aria-label="Close" className="grid size-8 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div>
      <h2 id="table-action-title" className="mt-2 text-lg font-bold">{action.kind === 'move' ? `Move ${action.table.name} to…` : `Merge ${action.table.name} into…`}</h2>
      <p className="mt-1 text-xs text-[#718077]">{action.kind === 'move' ? 'Only free tables are listed. The kitchen is not re-sent anything.' : `${action.table.name}'s items join the chosen table's order and ${action.table.name} becomes free.`}</p>
      {choices.length ? <div className="mt-3 grid max-h-56 grid-cols-3 gap-2 overflow-y-auto">{choices.map(table => <button key={table.id} type="button" onClick={() => setTarget(action.kind === 'move' ? table.id : table.order!.id)} className={`rounded-lg border px-2 py-2 text-left text-[10px] ${target === (action.kind === 'move' ? table.id : table.order?.id) ? 'border-[#93bba0] bg-[#edf6ef] font-bold text-[#34704c]' : 'border-[#e5ebe6] text-[#5f6f66]'}`}>{table.name}<small className="block text-[8px] text-[#98a29d]">{table.areaName}</small></button>)}</div>
        : <p className="mt-3 rounded-lg bg-[#fcf6eb] p-3 text-xs text-[#936e3e]">{action.kind === 'move' ? 'No free tables right now.' : 'No other table has an open order.'}</p>}
      <label className="mt-3 block text-xs font-medium text-[#526259]">Reason<input value={reason} onChange={event => setReason(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[#e5ebe6] px-2 text-xs"/></label>
      <button type="button" disabled={!target || busy || reason.trim().length < 3} onClick={() => void submitAction()} className="mt-4 h-10 w-full rounded-lg bg-[#27694f] text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : action.kind === 'move' ? 'Move order' : 'Merge orders'}</button>
    </section></div>}
  </section>;
}
