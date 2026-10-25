import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FilePlus2, LayoutDashboard, LogOut, Menu, ShieldCheck, UsersRound } from 'lucide-react';
import InspectionPage from './pages/InspectionPage';
import RequestsPage from './pages/RequestsPage';
import AdminPage from './pages/AdminPage';
import ContractorsPage from './pages/ContractorsPage';
import StaffLoginPage from './pages/StaffLoginPage';
import ScreeningPage from './pages/ScreeningPage';
import { AUTH_STORAGE_SIGNAL, getSession, isOfflinePreview, signalAuthChange, signOut, type AuthSession } from './lib/auth';
import type { Page } from './lib/types';
import './customer.css';

const pageLabels: Record<Page, string> = {
  inspection: 'Request a review', screening: 'Start a screening', requests: 'My requests',
  admin: 'Client dashboard', contractors: 'Find a specialist', login: 'Staff sign in',
};

function readPage(): Page {
  const value = window.location.hash.slice(1).split('?')[0];
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
  const [routeHash, setRouteHash] = useState(() => window.location.hash);
  const [menuOpen, setMenuOpen] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const sessionVersion = useRef(0);
  const sessionRef = useRef<AuthSession | null>(null);
  const signingOut = useRef(false);

  const navigate = useCallback((next: Page) => {
    window.location.hash = next;
    setPage(next);
    setMenuOpen(false);
  }, []);

  const applySession = useCallback((next: AuthSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const refreshSession = useCallback(async (showLoading = false) => {
    if (signingOut.current) return;
    const version = ++sessionVersion.current;
    if (showLoading) setAuthLoading(true);
    try {
      const next = await getSession();
      if (version !== sessionVersion.current) return;
      if (sessionRef.current?.user && !next.user) setAuthNotice('Your staff session ended. Please sign in again.');
      applySession(next);
      setAuthError('');
    } catch (cause) {
      if (version !== sessionVersion.current) return;
      applySession(null);
      setAuthError(cause instanceof Error ? cause.message : 'Staff access could not be loaded. Please try again.');
    } finally {
      if (version === sessionVersion.current) setAuthLoading(false);
    }
  }, [applySession]);

  useEffect(() => {
    void refreshSession(true);
    const revalidate = () => { if (document.visibilityState === 'visible') void refreshSession(); };
    const changedInAnotherTab = (event: StorageEvent) => { if (event.key === AUTH_STORAGE_SIGNAL) void refreshSession(); };
    const unauthorized = () => {
      if (!sessionRef.current?.user) return;
      sessionVersion.current++;
      applySession({ user: null, setupRequired: false });
      setAuthLoading(false);
      setAuthError('');
      setSignOutError('');
      setAuthNotice('Your staff session ended. Please sign in again.');
      signalAuthChange();
      navigate('login');
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    window.addEventListener('storage', changedInAnotherTab);
    window.addEventListener('moldlens:unauthorized', unauthorized);
    const timer = isOfflinePreview ? undefined : window.setInterval(revalidate, 60_000);
    return () => {
      sessionVersion.current++;
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
      window.removeEventListener('storage', changedInAnotherTab);
      window.removeEventListener('moldlens:unauthorized', unauthorized);
      window.clearInterval(timer);
    };
  }, [applySession, navigate, refreshSession]);

  useEffect(() => {
    const syncPage = () => {
      setPage(readPage());
      setRouteHash(window.location.hash);
      setMenuOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', syncPage);
    return () => window.removeEventListener('hashchange', syncPage);
  }, []);

  const isStaff = !isOfflinePreview && !!session?.user;
  const showAdmin = page === 'admin' && isStaff && !authError;
  const staffScreening = page === 'screening' && new URLSearchParams(routeHash.split('?')[1] || '').get('view') === 'staff';
  const staffRoute = page === 'admin' || page === 'login' || staffScreening;
  const showScreening = page === 'screening' && (!staffScreening || (isStaff && !authError));

  useEffect(() => {
    document.title = `${staffRoute && (!isStaff || authError) ? 'Staff sign in' : staffScreening ? 'Screening details' : pageLabels[page]} · MoldLens`;
  }, [page, staffRoute, staffScreening, isStaff, authError]);

  useEffect(() => { if (page === 'login' && isStaff) navigate('admin'); }, [isStaff, navigate, page]);

  function signedIn(next: AuthSession) {
    sessionVersion.current++;
    applySession(next);
    setAuthLoading(false);
    setAuthError('');
    setAuthNotice('');
    setSignOutError('');
    if (!staffScreening) navigate('admin');
  }

  async function logout() {
    if (signingOut.current) return;
    signingOut.current = true;
    sessionVersion.current++;
    setSignOutPending(true);
    setSignOutError('');
    try {
      const next = await signOut();
      if (next.user) throw new Error('We couldn’t sign you out. Please try again.');
      sessionVersion.current++;
      applySession(next);
      setAuthLoading(false);
      setAuthError('');
      setAuthNotice('');
      signalAuthChange();
      navigate('inspection');
    } catch (cause) {
      setSignOutError(cause instanceof Error ? cause.message : 'We couldn’t sign you out. Please try again.');
    } finally {
      signingOut.current = false;
      setSignOutPending(false);
    }
  }

  const signOutButton = <button className="staff-signout" disabled={signOutPending} onClick={() => void logout()}><LogOut size={15} />{signOutPending ? 'Signing out…' : 'Sign out'}</button>;

  const skipLink = <a href="#main-content" className="skip-link" onClick={event => {
    event.preventDefault();
    document.getElementById('main-content')?.focus();
  }}>Skip to content</a>;

  if (!showAdmin) {
    return <div className="customer-shell">
      {skipLink}
      <header className="customer-header">
        <Brand />
        <nav aria-label="Customer navigation">
          <a href="#requests" aria-current={page === 'requests' ? 'page' : undefined}>My requests</a>
        </nav>
      </header>
      {isStaff && <aside className="staff-viewbar" aria-label="Staff controls">
        <span className="staff-viewbar-account"><ShieldCheck size={16} /><span>Signed in as <strong>{session?.user?.email}</strong></span></span>
        <div><a href="#admin"><LayoutDashboard size={16} />Back to dashboard</a>{signOutButton}</div>
      </aside>}
      {signOutError && <p className="staff-session-error" role="alert">{signOutError}</p>}
      <main id="main-content" className={`customer-main customer-main-${page}`} tabIndex={-1}>
        {page === 'inspection' && <InspectionPage onNavigate={navigate} />}
        {showScreening && <ScreeningPage readOnly={staffScreening} />}
        {page === 'requests' && <RequestsPage onNavigate={navigate} />}
        {page === 'contractors' && <ContractorsPage onNavigate={navigate} />}
        {staffRoute && !showScreening && <StaffLoginPage session={session} loading={authLoading} error={authError} notice={authNotice} onRetry={() => void refreshSession(true)} onSignedIn={signedIn} />}
      </main>
      <footer className="customer-footer">
        <span>MoldLens · Ottawa</span>
        <nav aria-label="More options">
          {page === 'contractors' ? <a href="#inspection">Request a review</a> : <a href="#contractors">Find a specialist</a>}
          {!isStaff && <a href="#login" aria-current={staffRoute ? 'page' : undefined}>Staff sign in</a>}
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
        <a href="#screening" className="nav-item"><ShieldCheck size={19} />Start a screening</a>
      </nav>
      <a href="#inspection" className="team-back-link"><ArrowLeft size={15} />Back to customer page</a>
    </aside>
    <div className="workspace-main">
      <header className="topbar staff-topbar">
        <div className="topbar-left">
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Open navigation" aria-expanded={menuOpen}><Menu size={22} /></button>
          <span className="breadcrumb-current">Client dashboard</span>
        </div>
        <div className="staff-topbar-controls">
          <span className="staff-account-email" title={session?.user?.email}>{session?.user?.email}</span>
          <a className="staff-customer-link" href="#inspection"><ArrowLeft size={15} />View customer page</a>
          {signOutButton}
        </div>
      </header>
      {signOutError && <p className="staff-session-error" role="alert">{signOutError}</p>}
      <main id="main-content" className="main-content" tabIndex={-1}><AdminPage onNavigate={navigate} /></main>
      <footer className="app-footer"><span>MoldLens · Team workspace</span><span>Ottawa, ON</span></footer>
    </div>
  </div>;
}
