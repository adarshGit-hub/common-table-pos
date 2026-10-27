import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import type { CustomerSummary } from '@common-table/contracts';
import { formatMoney, getJson } from './api';

/** Optional guest phone and name; recognises a returning customer as the phone is typed. */
export default function CustomerField({ phone, name, currency, onChange, onSave }: {
  phone: string; name: string; currency: string;
  onChange: (next: { phone: string; name: string }) => void;
  /** When set (a saved order), shows a button that links the entered customer to it. */
  onSave?: () => void;
}) {
  const [known, setKnown] = useState<CustomerSummary | null>(null);
  const digits = phone.replace(/[\s()+-]/g, '');
  useEffect(() => {
    if (!/^[0-9]{10,15}$/.test(digits)) { setKnown(null); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void getJson<{ customer: CustomerSummary | null }>(`/api/customers/lookup?phone=${encodeURIComponent(digits)}`)
        .then(result => { if (!active) return; setKnown(result.customer); if (result.customer?.name && !name) onChange({ phone, name: result.customer.name }); })
        .catch(() => { if (active) setKnown(null); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
    // Only look up when the number itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  return <div className="mb-2 rounded-md border border-[#e6ece7] px-2 py-1.5">
    <div className="flex items-center gap-1.5"><UserRound size={12} className="shrink-0 text-[#7d9385]"/>
      <input aria-label="Customer phone" inputMode="tel" value={phone} onChange={event => onChange({ phone: event.target.value, name })} placeholder="Customer phone (optional)" className="w-28 min-w-0 flex-1 bg-transparent text-[9px] text-[#324239] outline-none placeholder:text-[#9ca8a1]"/>
      <input aria-label="Customer name" value={name} onChange={event => onChange({ phone, name: event.target.value })} placeholder="Name" maxLength={80} className="w-20 min-w-0 flex-1 bg-transparent text-[9px] text-[#324239] outline-none placeholder:text-[#9ca8a1]"/>
      {onSave && <button type="button" disabled={!/^[0-9]{10,15}$/.test(digits)} onClick={onSave} className="rounded border border-[#e3e9e4] px-1.5 py-0.5 text-[8px] font-semibold text-[#43624f] disabled:opacity-40">Save</button>}
    </div>
    {known && <p className="mt-1 text-[8px] text-[#4e805e]">Returning guest · {known.visitCount} visit{known.visitCount === 1 ? '' : 's'} · {formatMoney(known.totalSpendMinor, currency)} spent{known.lastVisitAt ? ` · last ${new Date(known.lastVisitAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</p>}
  </div>;
}
