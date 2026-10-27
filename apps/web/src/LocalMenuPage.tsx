import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, Pencil, Plus, Trash2, X } from 'lucide-react';
import { formatMoney, getJson, newCommandId, sendJson } from './api';

interface EditorItem {
  id: string; name: string; category: string; priceMinor: number; emoji: string; color: string; tag: string | null;
  vegetarian: boolean; available: boolean; kitchenStation: string; taxCode: string | null; taxRateBps: number | null;
  modifiers: Array<{ id: string; group: string; name: string; priceDeltaMinor: number }>;
}
interface MenuEditor { setupMode: 'standalone' | 'cloud'; items: EditorItem[]; categories: string[]; stations: string[] }

type Draft = { id?: string; name: string; category: string; price: string; kitchenStation: string; vegetarian: boolean; taxRate: string; taxCode: string; emoji: string; color: string; tag: string; modifiers: string };

const input = 'mt-1 h-9 w-full rounded-lg border border-[#e5ebe6] bg-white px-2 text-xs';
const emptyDraft = (editor: MenuEditor): Draft => ({ name: '', category: editor.categories[0] ?? '', price: '', kitchenStation: editor.stations[0] ?? 'Kitchen',
  vegetarian: true, taxRate: '', taxCode: '', emoji: '🍽️', color: '#f3ece0', tag: '', modifiers: '' });

/** "Size: Half 0, Full 40; Spice: Mild 0" <-> modifier rows. */
function modifiersToText(modifiers: EditorItem['modifiers']): string {
  const groups = new Map<string, string[]>();
  for (const modifier of modifiers) groups.set(modifier.group, [...(groups.get(modifier.group) ?? []), `${modifier.name} ${modifier.priceDeltaMinor / 100}`]);
  return [...groups].map(([group, options]) => `${group}: ${options.join(', ')}`).join('; ');
}
function textToModifiers(text: string) {
  return text.split(';').map(part => part.trim()).filter(Boolean).flatMap(part => {
    const [group = '', options = ''] = part.split(':');
    return options.split(',').map(option => option.trim()).filter(Boolean).map(option => {
      const match = /^(.*?)(?:\s+(\d+(?:\.\d+)?))?$/.exec(option)!;
      return { group: group.trim(), name: match[1]!.trim(), priceDeltaMinor: Math.round(Number(match[2] ?? 0) * 100) };
    });
  });
}

/** Manager menu editor for standalone terminals: items, prices, GST, stations, modifiers, availability. */
export default function LocalMenuPage({ currency, notify }: { currency: string; notify: (message: string) => void }) {
  const [editor, setEditor] = useState<MenuEditor | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setEditor(await getJson<MenuEditor>('/api/setup/menu')); } catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not load the menu.'); }
  }, [notify]);
  useEffect(() => { void load(); }, [load]);
  const money = (minor: number) => formatMoney(minor, currency);

  async function save() {
    if (!draft) return;
    setBusy(true);
    const fields = { name: draft.name, category: draft.category, priceMinor: Math.round(Number(draft.price) * 100), kitchenStation: draft.kitchenStation,
      vegetarian: draft.vegetarian, taxRateBps: draft.taxRate === '' ? null : Math.round(Number(draft.taxRate) * 100), taxCode: draft.taxCode.trim() || null,
      emoji: draft.emoji, color: draft.color, tag: draft.tag.trim() || null };
    try {
      let id = draft.id;
      if (id) await sendJson(`/api/setup/menu/items/${id}`, fields, 'PATCH');
      else id = (await sendJson<{ id: string }>('/api/setup/menu/items', { commandId: newCommandId(), ...fields })).id;
      const modifiers = textToModifiers(draft.modifiers);
      const before = editor?.items.find(item => item.id === id)?.modifiers ?? [];
      if (modifiersToText(before) !== modifiersToText(modifiers.map((row, index) => ({ id: String(index), ...row }))))
        await sendJson(`/api/setup/menu/items/${id}/modifiers`, { modifiers }, 'PUT');
      notify(`${draft.name} saved`); setDraft(null); await load();
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not save the item.'); }
    finally { setBusy(false); }
  }
  async function act(label: string, request: () => Promise<unknown>) {
    setBusy(true);
    try { await request(); notify(label); await load(); } catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not update the menu.'); }
    finally { setBusy(false); }
  }

  if (!editor) return <div className="grid min-h-60 flex-1 place-items-center"><LoaderCircle className="animate-spin text-[#38805a]" size={26}/></div>;
  const readOnly = editor.setupMode === 'cloud';
  const visible = editor.items.filter(item => !filter || `${item.name} ${item.category}`.toLowerCase().includes(filter.toLowerCase()));
  const categories = [...new Set(visible.map(item => item.category))];

  return <section className="mx-auto w-full max-w-[1100px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="mb-1.5 text-[8px] font-bold tracking-[1px] text-[#87948d]">OUTLET SETUP</p><h1 className="text-[23px] font-bold tracking-[-1px] sm:text-[26px]">Menu</h1><p className="mt-1 text-[10px] text-[#8a9690]">{editor.items.length} items. Price changes apply to new orders only.</p></div>
      <div className="flex gap-2"><input aria-label="Search menu items" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search" className="h-9 rounded-lg border border-[#dfe6e1] bg-white px-2 text-xs"/>{!readOnly && <button type="button" onClick={() => setDraft(emptyDraft(editor))} className="flex h-9 items-center gap-1 rounded-lg bg-[#27694f] px-3 text-xs font-semibold text-white"><Plus size={13}/>New item</button>}</div></header>
    {readOnly && <p className="mb-4 rounded-xl border border-[#efe5ce] bg-[#fffaf0] p-3 text-xs text-[#8a7857]">This terminal is paired with the cloud; edit the menu in the cloud portal.</p>}
    {categories.map(category => <section key={category} className="mb-3 rounded-2xl border border-[#e1e8e1] bg-white p-4">
      <h2 className="mb-2 text-[12px] font-bold">{category}</h2>
      <div className="divide-y divide-[#edf0ed]">{visible.filter(item => item.category === category).map(item => <div key={item.id} className="flex items-center gap-3 py-2 text-[11px]">
        <span className="grid size-8 place-items-center rounded-lg text-lg" style={{ backgroundColor: item.color }}>{item.emoji}</span>
        <span className="min-w-0 flex-1"><strong className="block truncate text-[#283b31]">{item.name}</strong><small className="text-[9px] text-[#98a29d]">{item.kitchenStation} · GST {item.taxRateBps == null ? 'outlet rate' : `${item.taxRateBps / 100}%`}{item.taxCode ? ` · HSN/SAC ${item.taxCode}` : ''}{item.modifiers.length ? ` · ${item.modifiers.length} options` : ''}</small></span>
        <strong className="w-20 text-right">{money(item.priceMinor)}</strong>
        <button type="button" disabled={busy || readOnly} onClick={() => void act(`${item.name} ${item.available ? 'sold out' : 'back in stock'}`, () => sendJson(`/api/menu/items/${item.id}/availability`, { available: !item.available }))} className={`w-24 rounded-full px-2 py-1 text-[9px] font-semibold ${item.available ? 'bg-[#edf6ef] text-[#4e805e]' : 'bg-[#fff3e0] text-[#9b6a1f]'}`}>{item.available ? 'Available' : 'Sold out'}</button>
        {!readOnly && <><button type="button" aria-label={`Edit ${item.name}`} onClick={() => setDraft({ id: item.id, name: item.name, category: item.category, price: String(item.priceMinor / 100), kitchenStation: item.kitchenStation, vegetarian: item.vegetarian,
          taxRate: item.taxRateBps == null ? '' : String(item.taxRateBps / 100), taxCode: item.taxCode ?? '', emoji: item.emoji, color: item.color, tag: item.tag ?? '', modifiers: modifiersToText(item.modifiers) })} className="grid size-7 place-items-center rounded-md border border-[#e5ebe6] text-[#5f6f66]"><Pencil size={12}/></button>
          <button type="button" aria-label={`Remove ${item.name}`} disabled={busy} onClick={() => { if (window.confirm(`Remove ${item.name} from the menu?`)) void act(`${item.name} removed`, () => sendJson(`/api/setup/menu/items/${item.id}/remove`, {})); }} className="grid size-7 place-items-center rounded-md border border-[#f1d6cf] text-[#9a493d]"><Trash2 size={12}/></button></>}
      </div>)}</div>
    </section>)}
    {draft && <div className="fixed inset-0 z-30 grid place-items-center bg-[#14221c]/55 p-4 backdrop-blur-[2px]"><form onSubmit={event => { event.preventDefault(); void save(); }} role="dialog" aria-modal="true" aria-labelledby="item-title" className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl border border-[#e3e9e4] bg-white p-5 shadow-2xl">
      <div className="flex items-center justify-between"><h2 id="item-title" className="text-lg font-bold">{draft.id ? 'Edit item' : 'New item'}</h2><button type="button" onClick={() => setDraft(null)} aria-label="Close" className="grid size-8 place-items-center rounded-lg bg-[#f4f6f4] text-[#68776f]"><X size={16}/></button></div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="col-span-2 text-xs font-medium text-[#526259]">Name<input required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} className={input}/></label>
        <label className="text-xs font-medium text-[#526259]">Category<input required list="menu-categories" value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })} className={input}/></label>
        <label className="text-xs font-medium text-[#526259]">Price ({currency})<input required type="number" min="0" step="0.01" value={draft.price} onChange={event => setDraft({ ...draft, price: event.target.value })} className={input}/></label>
        <label className="text-xs font-medium text-[#526259]">Kitchen station<input required list="menu-stations" value={draft.kitchenStation} onChange={event => setDraft({ ...draft, kitchenStation: event.target.value })} className={input}/></label>
        <label className="text-xs font-medium text-[#526259]">Tag (optional)<input value={draft.tag} maxLength={20} onChange={event => setDraft({ ...draft, tag: event.target.value })} placeholder="POPULAR" className={input}/></label>
        <label className="text-xs font-medium text-[#526259]">GST rate % (blank = outlet rate)<input type="number" min="0" max="28" step="0.5" value={draft.taxRate} onChange={event => setDraft({ ...draft, taxRate: event.target.value })} className={input}/></label>
        <label className="text-xs font-medium text-[#526259]">HSN/SAC code<input value={draft.taxCode} onChange={event => setDraft({ ...draft, taxCode: event.target.value })} placeholder="996331" className={input}/></label>
        <label className="text-xs font-medium text-[#526259]">Icon<input value={draft.emoji} onChange={event => setDraft({ ...draft, emoji: event.target.value })} className={input}/></label>
        <label className="text-xs font-medium text-[#526259]">Card colour<input type="color" value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value })} className={`${input} p-1`}/></label>
        <label className="col-span-2 flex items-center gap-2 text-xs text-[#526259]"><input type="checkbox" checked={draft.vegetarian} onChange={event => setDraft({ ...draft, vegetarian: event.target.checked })}/>Vegetarian</label>
        <label className="col-span-2 text-xs font-medium text-[#526259]">Options<input value={draft.modifiers} onChange={event => setDraft({ ...draft, modifiers: event.target.value })} placeholder="Size: Half 0, Full 40; Spice: Mild, Medium, Spicy" className={input}/><small className="mt-1 block text-[9px] font-normal text-[#98a29d]">Groups separated by ";" — each option is a name and an optional extra price.</small></label>
      </div>
      <datalist id="menu-categories">{editor.categories.map(category => <option key={category} value={category}/>)}</datalist>
      <datalist id="menu-stations">{editor.stations.map(station => <option key={station} value={station}/>)}</datalist>
      <button disabled={busy} className="mt-4 h-10 w-full rounded-lg bg-[#27694f] text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save item'}</button>
    </form></div>}
  </section>;
}
