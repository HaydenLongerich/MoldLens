import { useEffect, useState, type FormEvent } from 'react';
import { marketplace, type Company, type Invitation } from '../lib/marketplace';
import './contractor-directory.css';
import ContractorDirectory from './ContractorDirectory';

export default function ContractorNotifications({ company, onSaved }: { company: Company; onSaved: (company: Company) => void }) {
  const [postalCode, setPostalCode] = useState(company.postalCode || '');
  const [googlePlaceId, setGooglePlaceId] = useState(company.googlePlaceId || null);
  const [enabled, setEnabled] = useState(company.notificationsEnabled === true);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [mode, setMode] = useState('preview'); const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  useEffect(() => { void marketplace.invitations().then(result => { setInvitations(result.invitations); setMode(result.mode); setReady(result.ready); }).catch(cause => setNotice(cause.message)); }, [company]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice('');
    try { onSaved((await marketplace.companyProfile(postalCode, enabled, googlePlaceId)).company); setNotice('Location and email preference saved.'); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Please try again.'); } finally { setBusy(false); }
  }
  return <section className="market-panel contractor-notifications"><h2>Location & invitations</h2>{company.example ? <p>Example workspace. Create a company account to receive real screening invitations.</p> : <form onSubmit={event => void save(event)}><label>Company postal code<input required autoComplete="postal-code" maxLength={7} placeholder="L3Y 1A1" value={postalCode} onChange={event => setPostalCode(event.target.value.toUpperCase())} /></label><p>Match projects within 50 km of this postal code. Invitations use your signup email{company.notificationEmail ? `: ${company.notificationEmail}` : ''}.</p><label className="market-check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Email me when a completed screening is ready nearby.</label><details><summary>Google business profile (optional)</summary><p>Link your business so customers can read Google ratings alongside your quotes. This is a company-provided link, not a verified ownership badge.</p>{googlePlaceId && <><p>Business profile selected.</p><button type="button" className="market-text-button" onClick={() => setGooglePlaceId(null)}>Unlink profile</button></>}<ContractorDirectory postalCode={postalCode} onSelect={id => { setGooglePlaceId(id); setNotice('Business selected. Save preferences to link it.'); }} /></details><button className="btn btn-secondary" disabled={busy}>Save preferences</button></form>}
    <p className="directory-note">{mode === 'preview' ? 'Email preview mode. No emails are being sent.' : ready ? 'Email delivery is enabled.' : 'Email delivery is waiting for server setup.'}</p>{notice && <p role="status">{notice}</p>}
    {invitations.length > 0 && <details><summary>Quote invitations ({invitations.length})</summary>{invitations.map(item => <article className="invitation-preview" key={item.id}><strong>{item.reportId}</strong><p>{item.to} · {item.status === 'preview' ? 'Preview only' : item.status.replaceAll('_', ' ')}</p>{item.error && <p>Delivery needs attention: {item.error.replaceAll('_', ' ')}.</p>}{item.preview && <><strong>{item.preview.subject}</strong><p className="invitation-text">{item.preview.text}</p></>}<a href={`#partner?id=${encodeURIComponent(item.reportId)}`}>Review screening & quote</a></article>)}</details>}
  </section>;
}
