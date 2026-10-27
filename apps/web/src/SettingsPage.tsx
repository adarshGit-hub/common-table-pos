import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { getJson, sendJson } from './api';

export interface OutletSettingsView {
  setupMode: 'standalone' | 'cloud';
  cashierDiscountLimitBps: number;
  serviceChargeBps: number;
  defaultSac: string;
  quickNotes: string[];
  outlet: { name: string; taxRateBps: number; receiptName: string; receiptAddress: string; receiptPhone: string; gstin: string; receiptFooter: string };
}

const input = 'mt-1 h-9 w-full rounded-lg border border-[#e5ebe6] bg-white px-2 text-xs disabled:bg-[#f4f6f4]';
const card = 'rounded-2xl border border-[#e1e8e1] bg-white p-5 shadow-[0_8px_20px_rgba(25,37,34,.035)]';

/** Manager settings: billing rules, kitchen quick notes and (standalone only) outlet and receipt identity. */
export default function SettingsPage({ notify, onSaved }: { notify: (message: string) => void; onSaved: (settings: OutletSettingsView) => void }) {
  const [settings, setSettings] = useState<OutletSettingsView | null>(null);
  const [form, setForm] = useState({ discountLimit: '', serviceCharge: '', defaultSac: '', quickNotes: '', name: '', taxRate: '', receiptName: '', receiptAddress: '', receiptPhone: '', gstin: '', receiptFooter: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getJson<OutletSettingsView>('/api/settings').then(next => {
      setSettings(next);
      setForm({ discountLimit: String(next.cashierDiscountLimitBps / 100), serviceCharge: String(next.serviceChargeBps / 100), defaultSac: next.defaultSac,
        quickNotes: next.quickNotes.join(', '), name: next.outlet.name, taxRate: String(next.outlet.taxRateBps / 100), receiptName: next.outlet.receiptName,
        receiptAddress: next.outlet.receiptAddress, receiptPhone: next.outlet.receiptPhone, gstin: next.outlet.gstin, receiptFooter: next.outlet.receiptFooter });
    }).catch(cause => notify(cause instanceof Error ? cause.message : 'Could not load settings.'));
  }, [notify]);

  if (!settings) return <div className="grid min-h-60 flex-1 place-items-center"><LoaderCircle className="animate-spin text-[#38805a]" size={26}/></div>;
  const outletLocked = settings.setupMode === 'cloud';
  const field = (key: keyof typeof form, label: string, extra: Record<string, string> = {}) => <label className="block text-xs font-medium text-[#526259]">{label}<input aria-label={label} value={form[key]} disabled={busy || (outletLocked && !['discountLimit', 'serviceCharge', 'defaultSac', 'quickNotes'].includes(key))} onChange={event => setForm({ ...form, [key]: event.target.value })} className={input} {...extra}/></label>;

  async function save() {
    setBusy(true);
    try {
      const next = await sendJson<OutletSettingsView>('/api/settings', {
        cashierDiscountLimitBps: Math.round(Number(form.discountLimit) * 100), serviceChargeBps: Math.round(Number(form.serviceCharge) * 100),
        defaultSac: form.defaultSac, quickNotes: form.quickNotes.split(',').map(note => note.trim()).filter(Boolean),
        ...(outletLocked ? {} : { outlet: { name: form.name, taxRateBps: Math.round(Number(form.taxRate) * 100), receiptName: form.receiptName,
          receiptAddress: form.receiptAddress, receiptPhone: form.receiptPhone, gstin: form.gstin.trim().toUpperCase(), receiptFooter: form.receiptFooter } }),
      }, 'PATCH');
      setSettings(next); onSaved(next); notify('Settings saved');
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not save settings.'); }
    finally { setBusy(false); }
  }

  return <section className="mx-auto w-full max-w-[900px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
    <header className="mb-5"><p className="mb-1.5 text-[8px] font-bold tracking-[1px] text-[#87948d]">OUTLET SETUP</p><h1 className="text-[23px] font-bold tracking-[-1px] sm:text-[26px]">Settings</h1><p className="mt-1 text-[10px] text-[#8a9690]">Billing rules and receipt details for this outlet.</p></header>
    <div className="grid gap-4">
      <section className={card}><h2 className="mb-3 text-[12px] font-bold">Billing</h2><div className="grid gap-3 sm:grid-cols-3">
        {field('discountLimit', 'Cashier discount limit (%)', { type: 'number', min: '0', max: '100', step: '0.5' })}
        {field('serviceCharge', 'Dine-in service charge (%)', { type: 'number', min: '0', max: '20', step: '0.5' })}
        {field('defaultSac', 'Default HSN/SAC code')}
      </div><p className="mt-2 text-[9px] text-[#98a29d]">Service charge is optional for guests and can be removed from any bill. Set it to 0 to turn it off.</p></section>
      <section className={card}><h2 className="mb-3 text-[12px] font-bold">Kitchen quick notes</h2>{field('quickNotes', 'Comma-separated, e.g. No onion, Jain, Less spicy')}</section>
      <section className={card}><h2 className="mb-1 text-[12px] font-bold">Outlet and receipt</h2>
        {outletLocked && <p className="mb-3 text-[10px] text-[#8a7857]">This terminal is paired with the cloud; edit these in the cloud portal.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {field('name', 'Outlet name')}{field('taxRate', 'Default GST rate (%)', { type: 'number', min: '0', max: '28', step: '0.5' })}
          {field('receiptName', 'Name on receipt')}{field('receiptPhone', 'Phone')}
          {field('gstin', 'GSTIN (15 characters)')}{field('receiptFooter', 'Receipt footer')}
          <div className="sm:col-span-2">{field('receiptAddress', 'Address')}</div>
        </div>
        <p className="mt-2 text-[9px] text-[#98a29d]">Check GST rates and invoice format with your accountant before using these bills for filing.</p>
      </section>
      <button type="button" disabled={busy} onClick={() => void save()} className="h-10 rounded-lg bg-[#27694f] text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save settings'}</button>
    </div>
  </section>;
}
