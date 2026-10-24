import { useEffect, useState } from 'react';
import { ArrowLeft, FilePlus2, LayoutDashboard, MapPin, Menu, ShieldCheck, UsersRound } from 'lucide-react';
import InspectionPage from './pages/InspectionPage';
import RequestsPage from './pages/RequestsPage';
import AdminPage from './pages/AdminPage';
import ContractorsPage from './pages/ContractorsPage';
import type { Page } from './lib/types';
import './customer.css';

const pageLabels: Record<Page, string> = {
  inspection: 'Request a review', requests: 'My requests',
  admin: 'Client dashboard', contractors: 'Find a specialist',
};

function readPage(): Page {
  const value = window.location.hash.replace('#', '');
  return Object.hasOwn(pageLabels, value) ? value as Page : 'inspection';
}

function Brand() {
  return <a href="#inspection" className="brand" aria-label="MoldLens home">
    <span className="brand-icon"><ShieldCheck size={29} strokeWidth={1.65} /></span>
    <span className="brand-wordmark">Mold<span>Lens</span></span>
  </a>;
}

export default function App() {
  const [page, setPage] = useState<Page>(readPage);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const syncPage = () => {
      setPage(readPage());
      setMenuOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', syncPage);
    return () => window.removeEventListener('hashchange', syncPage);
  }, []);

  useEffect(() => { document.title = `${pageLabels[page]} · MoldLens`; }, [page]);

  function navigate(next: Page) {
    window.location.hash = next;
    setPage(next);
    setMenuOpen(false);
  }

  const skipLink = <a href="#main-content" className="skip-link" onClick={event => {
    event.preventDefault();
    document.getElementById('main-content')?.focus();
  }}>Skip to content</a>;

  if (page !== 'admin') {
    return <div className="customer-shell">
      {skipLink}
      <header className="customer-header">
        <Brand />
        <nav aria-label="Customer navigation">
          <a href="#requests" aria-current={page === 'requests' ? 'page' : undefined}>My requests</a>
        </nav>
      </header>
      <main id="main-content" className={`customer-main customer-main-${page}`} tabIndex={-1}>
        {page === 'inspection' && <InspectionPage onNavigate={navigate} />}
        {page === 'requests' && <RequestsPage onNavigate={navigate} />}
        {page === 'contractors' && <ContractorsPage onNavigate={navigate} />}
      </main>
      <footer className="customer-footer">
        <span>MoldLens · Ottawa</span>
        <nav aria-label="More options">
          {page === 'contractors' ? <a href="#inspection">Request a review</a> : <a href="#contractors">Find a specialist</a>}
          <a href="#admin">Team dashboard</a>
        </nav>
      </footer>
    </div>;
  }

  return <div className="app-shell">
    {skipLink}
    {menuOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <aside className={`sidebar team-sidebar ${menuOpen ? 'is-open' : ''}`}>
      <Brand />
      <nav aria-label="Team navigation">
        <p className="nav-section-label">TEAM WORKSPACE</p>
        <a href="#admin" className="nav-item active" aria-current="page"><LayoutDashboard size={19} />Client dashboard</a>
        <a href="#contractors" className="nav-item"><UsersRound size={19} />Find a specialist</a>
        <a href="#inspection" className="nav-item"><FilePlus2 size={19} />Customer form</a>
      </nav>
      <a href="#inspection" className="team-back-link"><ArrowLeft size={15} />Back to customer page</a>
    </aside>
    <div className="workspace-main">
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Open navigation" aria-expanded={menuOpen}><Menu size={22} /></button>
          <span className="breadcrumb-current">Client dashboard</span>
        </div>
        <span className="header-location"><MapPin size={15} />Ottawa, ON</span>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}><AdminPage onNavigate={navigate} /></main>
      <footer className="app-footer"><span>MoldLens · Team workspace</span><a href="#inspection">View customer page</a></footer>
    </div>
  </div>;
}
