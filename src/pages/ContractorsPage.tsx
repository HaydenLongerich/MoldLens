import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, ArrowRight, ArrowUpRight, Bookmark, Check, CheckCheck, ChevronDown, Clock3, ExternalLink, GitCompareArrows, HeartHandshake, LayoutGrid, List, MapPin, Phone, Search, ShieldCheck, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { api } from '../lib/api';
import type { Contractor, PageProps } from '../lib/types';
import './contractors.css';

const SERVICE_FILTERS = ['All specialists', 'Mold removal', 'Mold inspection', 'Air quality testing', 'Water damage'];
const phoneLink = (phone: string) => `tel:+1${phone.replace(/\D/g, '')}`;

function ProviderLogo({ contractor, small = false }: { contractor: Contractor; small?: boolean }) {
  return <span className={`contractor-logo contractor-logo-${contractor.color}${small ? ' contractor-logo-small' : ''}`} aria-hidden="true">
    {contractor.featured ? <ShieldCheck size={small ? 20 : 29} strokeWidth={1.7} /> : contractor.initials}
  </span>;
}

function Modal({ title, children, onClose, wide = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      trigger?.focus();
    };
  }, []);
  return <dialog className={`contractor-dialog${wide ? ' contractor-dialog-wide' : ''}`} ref={ref} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-label={title}>
    <div className="contractor-dialog-inner">
      <div className="contractor-dialog-heading"><h2>{title}</h2><button className="contractor-icon-btn" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>
      {children}
    </div>
  </dialog>;
}

export default function ContractorsPage({ onNavigate }: PageProps) {
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [service, setService] = useState('All specialists');
  const [sort, setSort] = useState('featured');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [savedOnly, setSavedOnly] = useState(false);
  const [saved, setSaved] = useState<string[]>(() => {
    try { const value = JSON.parse(localStorage.getItem('moldbusters-saved-contractors') || '[]'); return Array.isArray(value) ? value.filter(v => typeof v === 'string') : []; } catch { return []; }
  });
  const [compare, setCompare] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [profile, setProfile] = useState<Contractor | null>(null);

  async function load() {
    setLoading(true); setError('');
    try { setContractors(await api.getContractors()); }
    catch (error) { setError(error instanceof Error ? error.message : 'The directory could not be loaded.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { try { localStorage.setItem('moldbusters-saved-contractors', JSON.stringify(saved)); } catch { /* Saved providers remain available for this session. */ } }, [saved]);
  const filtered = useMemo(() => contractors.filter(item => {
    const text = `${item.name} ${item.area} ${item.services.join(' ')}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase().trim())) && (service === 'All specialists' || item.services.includes(service)) && (!savedOnly || saved.includes(item.id));
  }).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : Number(!!b.featured) - Number(!!a.featured)), [contractors, query, service, sort, savedOnly, saved]);
  const comparedProviders = contractors.filter(provider => compare.includes(provider.id));
  const toggleSave = (id: string) => setSaved(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const toggleCompare = (id: string) => setCompare(current => current.includes(id) ? current.filter(value => value !== id) : current.length < 3 ? [...current, id] : current);
  const resetFilters = () => { setQuery(''); setService('All specialists'); setSavedOnly(false); };

  return <div className="contractors-page">
    <div className="contractors-page-heading">
      <div><div className="eyebrow">LOCAL EXPERTISE. MORE OPTIONS.</div><h1 className="page-heading">Good help is close to home.</h1><p className="page-description">Find the right mold specialist for your home, your needs, and your next step.</p></div>
      <span className="contractors-location"><MapPin size={15} /> Ottawa, Ontario <span className="contractors-location-dot" /></span>
    </div>

    <section className="contractor-intro" aria-labelledby="contractor-intro-title">
      <div className="contractor-intro-icon"><HeartHandshake size={32} strokeWidth={1.5} /></div>
      <div><span className="contractor-mini-label">YOUR HOME COMES FIRST</span><h2 id="contractor-intro-title">A little busy on our end? You still have options.</h2><p>Explore local providers, compare their services, and reach out directly. We’re here to help you find a way forward.</p></div>
      <div className="contractor-intro-mark" aria-hidden="true"><span /><span /><span /><MapPin size={36} strokeWidth={1.3} /></div>
    </section>

    <section className="contractor-directory" aria-label="Ottawa specialist directory">
      <div className="contractor-search-row">
        <label className="contractor-search"><Search size={19} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search a specialist, service, or neighbourhood..." aria-label="Search specialists" />{query && <button onClick={() => setQuery('')} aria-label="Clear search"><X size={15} /></button>}</label>
        <button className={`contractor-saved-filter${savedOnly ? ' is-active' : ''}`} onClick={() => setSavedOnly(value => !value)} aria-pressed={savedOnly}><Bookmark size={17} fill={savedOnly ? 'currentColor' : 'none'} /> Saved <span>{saved.length}</span></button>
      </div>
      <div className="contractor-filter-row">
        <div className="contractor-filters" aria-label="Filter by service">{SERVICE_FILTERS.map(item => <button key={item} onClick={() => setService(item)} className={service === item ? 'is-active' : ''} aria-pressed={service === item}>{item === 'All specialists' && <SlidersHorizontal size={14} />}{item}</button>)}</div>
      </div>
      <div className="contractor-results-row">
        <p><strong>{loading ? '—' : filtered.length} specialists</strong> serving the Ottawa area</p>
        <div className="contractor-sort-actions"><label className="contractor-sort"><ArrowDownUp size={14} /><select value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort specialists"><option value="featured">Featured first</option><option value="name">Name: A–Z</option></select><ChevronDown size={13} /></label><span className="contractor-view-toggle"><button aria-label="Grid view" aria-pressed={view === 'grid'} className={view === 'grid' ? 'is-active' : ''} onClick={() => setView('grid')}><LayoutGrid size={16} /></button><button aria-label="List view" aria-pressed={view === 'list'} className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')}><List size={17} /></button></span></div>
      </div>

      {loading ? <div className="contractor-grid" aria-busy="true" aria-label="Loading specialists">{[1, 2, 3].map(item => <div className="contractor-skeleton" key={item}><span /><span /><span /><span /></div>)}</div> : error ? <div className="empty-state contractor-empty" role="alert"><h3>We couldn’t load the specialists.</h3><p>{error}</p><button className="btn btn-primary" onClick={() => void load()}>Try again</button></div> : filtered.length === 0 ? <div className="empty-state contractor-empty"><Search size={32} /><h3>No specialists match just yet.</h3><p>Try a different service or neighbourhood, or clear your filters.</p><button className="btn btn-secondary" onClick={resetFilters}>Clear filters</button></div> : <div className={`contractor-grid ${view === 'list' ? 'contractor-list' : ''}`}>
        {filtered.map(contractor => <article className={`contractor-card${contractor.featured ? ' contractor-card-featured' : ''}`} key={contractor.id}>
          {contractor.featured && <div className="contractor-featured-label"><Sparkles size={12} /> START WITH MOLD BUSTERS</div>}
          <div className="contractor-card-content">
            <div className="contractor-card-top"><ProviderLogo contractor={contractor} /><button className={`contractor-icon-btn${saved.includes(contractor.id) ? ' is-saved' : ''}`} aria-label={`${saved.includes(contractor.id) ? 'Unsave' : 'Save'} ${contractor.name}`} aria-pressed={saved.includes(contractor.id)} onClick={() => toggleSave(contractor.id)}><Bookmark size={19} fill={saved.includes(contractor.id) ? 'currentColor' : 'none'} /></button></div>
            <div className="contractor-card-title"><h2>{contractor.name}</h2><p>{contractor.tagline}</p></div>
            <p className="contractor-area"><MapPin size={14} />{contractor.area}</p>
            <div className="contractor-service-tags">{contractor.services.slice(0, 3).map(item => <span key={item}>{item}</span>)}</div>
            <div className="contractor-price"><span>{contractor.featured ? 'VIRTUAL INSPECTION' : 'SERVICE PRICING'}</span><strong>{contractor.price}{contractor.featured && <span className="contractor-no-obligation">No obligation</span>}</strong><p>{contractor.priceNote}</p></div>
            <div className="contractor-availability"><Clock3 size={14} /><span>{contractor.availability}</span></div>
            <div className="contractor-card-actions"><button className={`btn ${contractor.featured ? 'btn-primary' : 'btn-secondary'}`} onClick={() => contractor.featured ? onNavigate('inspection') : setProfile(contractor)}>{contractor.featured ? 'Start free inspection' : 'View specialist'}<ArrowUpRight size={16} /></button><a className="contractor-call" href={phoneLink(contractor.phone)} aria-label={`Call ${contractor.name}`}><Phone size={17} /></a></div>
            <div className="contractor-card-footer"><label title={compare.length === 3 && !compare.includes(contractor.id) ? 'Choose up to three specialists to compare' : undefined}><input type="checkbox" checked={compare.includes(contractor.id)} onChange={() => toggleCompare(contractor.id)} disabled={compare.length >= 3 && !compare.includes(contractor.id)} /><span>Compare</span></label><a href={contractor.sourceUrl} target="_blank" rel="noreferrer">Provider website <ExternalLink size={11} /></a></div>
          </div>
        </article>)}
        {service === 'All specialists' && !query && !savedOnly && <aside className="contractor-help-card"><span className="contractor-help-icon"><HeartHandshake size={30} strokeWidth={1.5} /></span><span className="contractor-mini-label">NOT SURE WHERE TO START?</span><h2>Let’s take the<br />first step together.</h2><p>Share a few details and photos. Our inspection request helps put the right information in front of the team.</p><button className="btn btn-secondary" onClick={() => onNavigate('inspection')}>Request an inspection <ArrowRight size={16} /></button><span className="contractor-help-note"><Check size={13} /> Free virtual inspection request</span></aside>}
      </div>}

      <div className="contractor-directory-note"><ShieldCheck size={17} /><p><strong>Public directory · Confirm availability with the provider.</strong> Information comes from provider websites. Listed businesses are independent; a listing does not imply a partnership. On-site pricing depends on the property and scope of work.</p></div>
    </section>

    {compare.length > 0 && <div className="contractor-compare-bar" role="region" aria-label="Selected specialists to compare"><div className="contractor-compare-preview"><GitCompareArrows size={21} /><div><strong>{compare.length} specialist{compare.length !== 1 ? 's' : ''} selected</strong><span>Compare up to 3 side by side</span></div><div className="contractor-compare-logos">{comparedProviders.map(item => <ProviderLogo key={item.id} contractor={item} small />)}</div></div><div className="contractor-compare-controls"><button className="contractor-clear-compare" onClick={() => setCompare([])}>Clear</button><button className="btn btn-primary" disabled={compare.length < 2} onClick={() => setShowCompare(true)}>Compare {compare.length > 1 ? compare.length : ''}<ArrowRight size={15} /></button></div></div>}

    {profile && <Modal title="Meet your local specialist" onClose={() => setProfile(null)}><div className="contractor-profile-head"><ProviderLogo contractor={profile} /><div><h3>{profile.name}</h3><p>{profile.tagline}</p></div></div><p className="contractor-profile-description">{profile.description}</p><div className="contractor-profile-facts"><div><MapPin size={18} /><div><span>Service area</span><strong>{profile.area}</strong></div></div><div><Clock3 size={18} /><div><span>Published hours</span><strong>{profile.availability}</strong></div></div><div><CheckCheck size={18} /><div><span>Pricing</span><strong>{profile.price}</strong><p>{profile.priceNote}</p></div></div></div><div className="contractor-service-tags">{profile.services.map(item => <span key={item}>{item}</span>)}</div><div className="contractor-profile-actions"><a className="btn btn-primary" href={phoneLink(profile.phone)}><Phone size={16} />{profile.phone}</a><a className="btn btn-secondary" href={profile.website} target="_blank" rel="noreferrer">Visit website <ArrowUpRight size={16} /></a></div><p className="contractor-profile-source">Availability and prices are confirmed directly with the provider. <a href={profile.sourceUrl} target="_blank" rel="noreferrer">View the official source <ExternalLink size={11} /></a></p></Modal>}

    {showCompare && <Modal title="A clearer picture, side by side." onClose={() => setShowCompare(false)} wide><p className="contractor-comparison-intro">Compare published services and contact each specialist for your property’s quote.</p><div className="contractor-comparison-scroll"><table className="contractor-comparison-table"><thead><tr><th scope="col">Your options</th>{comparedProviders.map(item => <th scope="col" key={item.id}><ProviderLogo contractor={item} small /><strong>{item.name}</strong></th>)}</tr></thead><tbody><tr><th scope="row">Pricing</th>{comparedProviders.map(item => <td key={item.id}><strong>{item.price}</strong><p>{item.priceNote}</p></td>)}</tr><tr><th scope="row">Service area</th>{comparedProviders.map(item => <td key={item.id}>{item.area}</td>)}</tr><tr><th scope="row">Services</th>{comparedProviders.map(item => <td key={item.id}><ul>{item.services.map(value => <li key={value}><Check size={12} />{value}</li>)}</ul></td>)}</tr><tr><th scope="row">Published hours</th>{comparedProviders.map(item => <td key={item.id}>{item.availability}</td>)}</tr><tr><th scope="row">Get in touch</th>{comparedProviders.map(item => <td key={item.id}><a href={phoneLink(item.phone)} className="contractor-comparison-phone"><Phone size={13} />{item.phone}</a><a href={item.sourceUrl} target="_blank" rel="noreferrer" className="contractor-comparison-source">Official website <ArrowUpRight size={12} /></a></td>)}</tr></tbody></table></div></Modal>}
  </div>;
}
