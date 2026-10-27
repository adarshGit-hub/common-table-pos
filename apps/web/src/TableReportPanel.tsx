import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { TableReport } from '@common-table/contracts';
import { formatMoney, getJson } from './api';

/** Dine-in sales, covers, average bill and time seated per table and area for one business day. */
export default function TableReportPanel({ date, refresh, card }: { date: string; refresh: number; card: string }) {
  const [report, setReport] = useState<TableReport | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getJson<TableReport>(`/api/reports/tables?date=${encodeURIComponent(date)}`)
      .then(next => { if (active) { setReport(next); setError(''); } })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load the table report.'); });
    return () => { active = false; };
  }, [date, refresh]);
  const money = (minor: number) => formatMoney(minor, report?.currency);

  return <section className={`${card} mt-4`}>
    <div className="mb-3 flex items-center justify-between"><div><h2 className="text-[12px] font-bold">Tables</h2><p className="text-[9px] text-[#98a29d]">Dine-in orders settled on this date, by table and area.</p></div>
      <a href={`/api/reports/tables.csv?date=${encodeURIComponent(date)}`} className="flex items-center gap-1 rounded-lg border border-[#dfe6e1] px-2.5 py-1.5 text-[9px] font-semibold text-[#40564b]"><Download size={12}/>CSV</a></div>
    {error ? <p className="text-[10px] text-[#9a493d]">{error}</p> : !report?.tables.length ? <p className="text-[10px] text-[#98a29d]">No dine-in orders were settled on this date.</p> : <>
      <div className="mb-3 flex flex-wrap gap-2">{report.areas.map(area => <span key={area.areaName} className="rounded-lg bg-[#f4f7f4] px-3 py-2 text-[10px] text-[#526259]"><strong className="text-[#283b31]">{area.areaName}</strong> · {money(area.salesMinor)} · {area.orderCount} orders · {area.guestCount} guests</span>)}</div>
      <div className="overflow-x-auto"><table className="w-full text-left text-[10px]"><thead className="text-[8px] uppercase tracking-wide text-[#98a29d]"><tr><th className="pb-2">Table</th><th className="pb-2">Area</th><th className="pb-2 text-right">Orders</th><th className="pb-2 text-right">Guests</th><th className="pb-2 text-right">Sales</th><th className="pb-2 text-right">Avg bill</th><th className="pb-2 text-right">Avg seated</th></tr></thead>
        <tbody>{report.tables.map(row => <tr key={row.tableId ?? row.tableName} className="border-t border-[#edf0ed]"><td className="py-2 font-semibold">{row.tableName}</td><td className="py-2 text-[#7d8a83]">{row.areaName}</td><td className="py-2 text-right">{row.orderCount}</td><td className="py-2 text-right">{row.guestCount}</td><td className="py-2 text-right">{money(row.salesMinor)}</td><td className="py-2 text-right">{money(row.averageBillMinor)}</td><td className="py-2 text-right">{row.averageSeatedMinutes} min</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
