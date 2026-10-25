import { ArrowRight } from 'lucide-react';
import { isOfflinePreview } from '../lib/auth';
import HouseExplorer from '../components/HouseExplorer';
import './landing.css';
import CustomerDemoTools from '../components/CustomerDemoTools';
import { initializeCustomerDemo } from '../lib/customer-demo';
import { customerDemoEnabled } from '../lib/testing';

export default function LandingPage() {
  return <section className="landing" aria-labelledby="landing-title">
    <div className="landing-copy">
      <p className="landing-kicker">A CLEARER LOOK AT YOUR SPACE</p>
      <h1 id="landing-title">Mold<span>Lens</span></h1>
      <p className="landing-summary">Worried about mold in your house?</p>
      <p className="landing-description">Find out in 5 minutes!</p>
      <a className="landing-primary" onClick={event => { if (customerDemoEnabled && !isOfflinePreview) { event.preventDefault(); void initializeCustomerDemo(true).then(() => { window.location.hash = 'screening'; }); } }} href={isOfflinePreview ? '#inspection' : '#screening'}>Detect your mold!<ArrowRight size={18} /></a>
      <p className="landing-note">Photo screening can’t confirm mold.</p>
      {customerDemoEnabled && !isOfflinePreview && <CustomerDemoTools home />}
    </div>
    <HouseExplorer />
  </section>;
}
