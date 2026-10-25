import { useEffect, useState, type FormEvent } from 'react';
import { marketplace, type CustomerDemo } from '../lib/marketplace';
import { initializeCustomerDemo } from '../lib/customer-demo';
import './customer-demo.css';

export default function CustomerDemoTools({ home = false, onChanged, onPostalCode }: { home?: boolean; onChanged?: () => void; onPostalCode?: (code: string) => void }) {
  const [state, setState] = useState<CustomerDemo | null>(null);
  const [username, setUsername] = useState(''); const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(true); const [error, setError] = useState('');
  useEffect(() => { let mounted = true; void initializeCustomerDemo(home).then(value => { if (mounted) { setState(value); setUsername(value.customer?.username || ''); setEmail(value.customer?.email || ''); } }).catch(cause => { if (mounted) setError(cause.message); }).finally(() => { if (mounted) setBusy(false); }); return () => { mounted = false; }; }, [home]);
  async function run(action: () => Promise<CustomerDemo>, identityChanged = false) {
    setBusy(true); setError('');
    try { const value = await action(); setState(value); setUsername(value.customer?.username || ''); setEmail(value.customer?.email || ''); window.dispatchEvent(new Event('moldlens-demo-changed')); if (identityChanged) onChanged?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); } finally { setBusy(false); }
  }
  function resume(event: FormEvent) { event.preventDefault(); void run(() => marketplace.continueCustomerDemo(email), true); }
  return <details className={`customer-demo-tools${home ? ' customer-demo-home' : ''}`}><summary>Customer demo{state?.customer ? ` · ${state.customer.username}` : ''}</summary><div className="customer-demo-body">
    <p>Reload home for a fresh guest. Continue with email to reopen a saved local demo.</p>
    <form onSubmit={event => { event.preventDefault(); void run(() => marketplace.nameCustomerDemo(username)); }}><label>Screening name<input value={username} required maxLength={60} onChange={event => setUsername(event.target.value)} disabled={busy} /></label><button className="btn btn-secondary" disabled={busy || !state?.customer}>Use name</button></form>
    <form onSubmit={resume}><label>Continue with email<input type="email" autoComplete="email" required value={email} maxLength={254} onChange={event => setEmail(event.target.value)} disabled={busy} /></label><button className="btn btn-secondary" disabled={busy}>Continue</button></form>
    {onPostalCode && <label>Postal-code test location<select defaultValue="" disabled={busy} onChange={event => { if (event.target.value) onPostalCode(event.target.value); }}><option value="">Choose a city</option>{state?.locations.map(item => <option key={item.city} value={item.postalCode}>{item.city} · {item.postalCode}</option>)}</select></label>}
    <button type="button" className="market-text-button" disabled={busy} onClick={() => void run(() => marketplace.startCustomerDemo(), true)}>Start a fresh guest</button>
    {state?.customer && !home && <button type="button" className="market-text-button" disabled={busy} onClick={() => void run(() => marketplace.exitCustomerDemo(), true)}>Leave customer demo</button>}
    <small>Demo email continuation is for local testing only. No account or email is sent.</small>{busy && <p role="status">Preparing demo…</p>}{error && <p role="alert">{error}</p>}
  </div></details>;
}
