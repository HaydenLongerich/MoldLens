import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { CustomerContact } from '../lib/marketplace';

export default function CustomerContactForm({ contact, busy, onSave, onCancel }: {
  contact?: CustomerContact | null; busy: boolean; onSave: (values: CustomerContact) => void; onCancel?: () => void;
}) {
  const id = useId();
  const [email, setEmail] = useState(contact?.email || '');
  const [phone, setPhone] = useState(contact?.phone || '');
  return <section className="market-panel market-contact-form">
    <h2>{contact ? 'Contact details' : 'Where can your contractor reach you?'}</h2>
    <p>Add your email and phone to view quotes. Only the contractor you choose will receive these details. No account needed.</p>
    <form onSubmit={event => { event.preventDefault(); onSave({ email: email.trim(), phone: phone.trim() }); }}>
      <label htmlFor={`${id}-email`}>Email<input id={`${id}-email`} type="email" autoComplete="email" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
      <label htmlFor={`${id}-phone`}>Phone number<input id={`${id}-phone`} type="tel" inputMode="tel" autoComplete="tel" required maxLength={40} value={phone} disabled={busy} placeholder="(905) 555-0123" onChange={event => setPhone(event.target.value)} /></label>
      <div className="market-quote-actions">{onCancel && <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>}<button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : contact ? 'Save contact details' : 'View quotes'}<ArrowRight size={16} /></button></div>
    </form>
  </section>;
}
