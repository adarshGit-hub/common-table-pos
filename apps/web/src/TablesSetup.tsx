import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import type { FloorView } from '@common-table/contracts';
import { getJson, newCommandId, sendJson } from './api';

const input = 'h-9 rounded-lg border border-[#e5ebe6] bg-white px-2 text-xs';
const card = 'rounded-2xl border border-[#e1e8e1] bg-white p-5 shadow-[0_8px_20px_rgba(25,37,34,.035)]';

/** Manager screen for dining areas and tables on a standalone (unpaired) terminal. */
export default function TablesSetup({ liveTick, notify }: { liveTick: number; notify: (message: string) => void }) {
  const [floor, setFloor] = useState<FloorView | null>(null);
  const [areaName, setAreaName] = useState('');
  const [bulk, setBulk] = useState({ areaId: '', prefix: 'Table', from: '1', to: '6', capacity: '4' });
  const [editing, setEditing] = useState<{ id: string; name: string; capacity: string; areaId: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getJson<FloorView>('/api/floor');
      setFloor(next);
      setBulk(previous => next.areas.some(area => area.id === previous.areaId) ? previous : { ...previous, areaId: next.areas[0]?.id ?? '' });
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not load tables.'); }
  }, [notify]);
  useEffect(() => { void load(); }, [load, liveTick]);

  async function run(label: string, request: () => Promise<unknown>) {
    setBusy(true);
    try { await request(); notify(label); await load(); }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not save this change.'); }
    finally { setBusy(false); }
  }

  if (!floor) return <div className="grid min-h-60 flex-1 place-items-center"><LoaderCircle className="animate-spin text-[#38805a]" size={26}/></div>;
  const readOnly = floor.setupMode === 'cloud';

  return <section className="mx-auto w-full max-w-[1100px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
    <header className="mb-5"><p className="mb-1.5 text-[8px] font-bold tracking-[1px] text-[#87948d]">OUTLET SETUP</p><h1 className="text-[23px] font-bold tracking-[-1px] sm:text-[26px]">Tables</h1><p className="mt-1 text-[10px] text-[#8a9690]">Dining areas and tables used by the floor, orders and table reports.</p></header>
    {readOnly && <p className="mb-4 rounded-xl border border-[#efe5ce] bg-[#fffaf0] p-3 text-xs text-[#8a7857]">This terminal is paired with the cloud, so tables are managed in the cloud portal and shown here read-only.</p>}
    {!readOnly && <div className="mb-4 grid gap-4 lg:grid-cols-2">
      <form className={card} onSubmit={event => { event.preventDefault(); void run(`Added ${areaName.trim()}`, () => sendJson('/api/setup/areas', { commandId: newCommandId(), name: areaName })).then(() => setAreaName('')); }}>
        <h2 className="mb-1 text-[12px] font-bold">Add an area</h2><p className="mb-3 text-[9px] text-[#98a29d]">For example Ground floor, Terrace or AC hall.</p>
        <div className="flex gap-2"><input aria-label="Area name" value={areaName} onChange={event => setAreaName(event.target.value)} placeholder="Area name" className={`${input} flex-1`}/><button disabled={busy || !areaName.trim()} className="flex h-9 items-center gap-1 rounded-lg bg-[#27694f] px-3 text-xs font-semibold text-white disabled:opacity-50"><Plus size={13}/>Add</button></div>
      </form>
      <form className={card} onSubmit={event => { event.preventDefault(); void run('Tables added', () => sendJson('/api/setup/tables', { commandId: newCommandId(), areaId: bulk.areaId, prefix: bulk.prefix, from: Number(bulk.from), to: Number(bulk.to), capacity: Number(bulk.capacity) })); }}>
        <h2 className="mb-1 text-[12px] font-bold">Add numbered tables</h2><p className="mb-3 text-[9px] text-[#98a29d]">Creates e.g. Table 01 to Table 06 in one go.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          <select aria-label="Area" value={bulk.areaId} onChange={event => setBulk({ ...bulk, areaId: event.target.value })} className={`${input} col-span-2`}>{floor.areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}</select>
          <input aria-label="Name prefix" value={bulk.prefix} onChange={event => setBulk({ ...bulk, prefix: event.target.value })} placeholder="Prefix" className={input}/>
          <input aria-label="From number" type="number" min="0" value={bulk.from} onChange={event => setBulk({ ...bulk, from: event.target.value })} className={input}/>
          <input aria-label="To number" type="number" min="0" value={bulk.to} onChange={event => setBulk({ ...bulk, to: event.target.value })} className={input}/>
          <input aria-label="Seats per table" type="number" min="1" max="50" value={bulk.capacity} onChange={event => setBulk({ ...bulk, capacity: event.target.value })} className={input}/>
        </div>
        <button disabled={busy || !bulk.areaId} className="mt-3 flex h-9 items-center gap-1 rounded-lg bg-[#27694f] px-3 text-xs font-semibold text-white disabled:opacity-50"><Plus size={13}/>Add tables</button>
      </form>
    </div>}
    {floor.areas.map(area => <section key={area.id} className={`${card} mb-3`}>
      <div className="mb-3 flex items-center justify-between"><h2 className="text-[12px] font-bold">{area.name} <span className="font-normal text-[#98a29d]">· {area.tables.length} tables · {area.tables.reduce((sum, table) => sum + table.capacity, 0)} seats</span></h2>
        {!readOnly && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Remove ${area.name} and its tables?`)) void run(`Removed ${area.name}`, () => sendJson(`/api/setup/areas/${area.id}/remove`, { commandId: newCommandId() })); }} className="flex items-center gap-1 rounded-lg border border-[#f1d6cf] px-2 py-1 text-[10px] text-[#9a493d]"><Trash2 size={12}/>Remove area</button>}</div>
      {area.tables.length ? <div className="divide-y divide-[#edf0ed]">{area.tables.map(table => editing?.id === table.id
        ? <form key={table.id} className="flex flex-wrap items-center gap-2 py-2" onSubmit={event => { event.preventDefault(); void run(`Saved ${editing.name}`, () => sendJson(`/api/setup/tables/${table.id}`, { commandId: newCommandId(), name: editing.name, capacity: Number(editing.capacity), areaId: editing.areaId }, 'PATCH')).then(() => setEditing(null)); }}>
            <input aria-label="Table name" value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} className={`${input} w-32`}/>
            <input aria-label="Seats" type="number" min="1" max="50" value={editing.capacity} onChange={event => setEditing({ ...editing, capacity: event.target.value })} className={`${input} w-20`}/>
            <select aria-label="Move to area" value={editing.areaId} onChange={event => setEditing({ ...editing, areaId: event.target.value })} className={input}>{floor.areas.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select>
            <button disabled={busy} className="h-9 rounded-lg bg-[#27694f] px-3 text-xs font-semibold text-white">Save</button><button type="button" onClick={() => setEditing(null)} className="h-9 rounded-lg border border-[#e5ebe6] px-3 text-xs">Cancel</button>
          </form>
        : <div key={table.id} className="flex items-center gap-3 py-2 text-[11px]"><strong className="w-32 text-[#283b31]">{table.name}</strong><span className="text-[#7d8a83]">{table.capacity} seats</span><span className="text-[9px] text-[#98a29d]">{table.status === 'free' ? 'Free' : 'In use'}</span>
            {!readOnly && <span className="ml-auto flex gap-1"><button type="button" aria-label={`Edit ${table.name}`} onClick={() => setEditing({ id: table.id, name: table.name, capacity: String(table.capacity), areaId: area.id })} className="grid size-7 place-items-center rounded-md border border-[#e5ebe6] text-[#5f6f66]"><Pencil size={12}/></button>
              <button type="button" aria-label={`Remove ${table.name}`} disabled={busy || table.status !== 'free'} onClick={() => void run(`Removed ${table.name}`, () => sendJson(`/api/setup/tables/${table.id}/remove`, { commandId: newCommandId() }))} className="grid size-7 place-items-center rounded-md border border-[#f1d6cf] text-[#9a493d] disabled:opacity-40"><Trash2 size={12}/></button></span>}
          </div>)}</div>
        : <p className="text-[10px] text-[#98a29d]">No tables in this area yet.</p>}
    </section>)}
    {!floor.areas.length && <p className="rounded-2xl border border-dashed border-[#dfe8e1] bg-white p-6 text-center text-[11px] text-[#8c9891]">Add your first area, then add tables to it.</p>}
  </section>;
}
