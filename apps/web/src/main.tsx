import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';

// Earlier versions kept copies of outlet setup, menu and floor plan in the
// browser. The local cashier service is now the only source, so drop them.
try {
  for (const key of Object.keys(localStorage)) {
    if (/^common-table\.(edge-context|menu-context|menu-cache|floor-plan)\.v1/.test(key)) localStorage.removeItem(key);
  }
} catch { /* Storage may be unavailable in private browsing. */ }

const AdminApp = lazy(() => import('./AdminApp'));
const Page = window.location.pathname.startsWith('/admin') ? AdminApp : App;
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Suspense fallback={<div className="grid min-h-screen place-items-center bg-[#f3f6f2] text-sm text-[#65746b]">Loading manager tools…</div>}><Page /></Suspense></React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('Offline app shell is unavailable:', error);
    });
  });
}
