import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { memberActive, type Company } from '../lib/marketplace';

export default function ContractorMembership({ company, busy, demo, onPay, onSignOut }: { company: Company; busy: boolean; demo: boolean; onPay: () => void; onSignOut: () => void }) {
  const paid = memberActive(company);
  return <section className="market-panel market-membership"><span className="market-status">Demo membership</span><h1>Grow your mold business.</h1><p className="membership-price">$100<small>CAD / month</small></p><p>Review local screenings, send whole-project proposals, and message customers.</p>
    <ul><li>Customer screenings in your service area</li><li>Itemized estimates and confirmed quotes</li><li>In-app communication with customers</li></ul>
    {paid ? <p className="membership-receipt"><CheckCircle2 size={18} />Simulated payment recorded · {company.membership.receiptId}</p> : <p>This is a demo checkout. No card, real charge, or automatic renewal is connected.</p>}
    {demo && !paid && <button className="btn btn-primary" disabled={busy} onClick={onPay}>{busy ? 'Activating…' : 'Simulate $100 payment'}<ArrowRight size={16} /></button>}
    {!demo && !paid && <p>Payment activation is only available in the local demo.</p>}
    <button className="market-text-button" disabled={busy} onClick={onSignOut}>Sign out</button>
  </section>;
}
