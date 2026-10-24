import { useEffect, useState } from 'react';
import { ArrowRight, Camera, ChevronDown, FileText, MapPin, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import type { CustomerRequest, PageProps, RequestStatus } from '../lib/types';
import './simple-requests.css';

const statusDescriptions: Record<RequestStatus, string> = {
  New: 'Your request is saved and ready for review.',
  'In review': 'Your details are being reviewed.',
  Scheduled: 'See your appointment details below.',
  Completed: 'This request is complete.',
  Referred: 'Browse local specialists for your next step.',
};

function dateLabel(value: string) {
  return new Date(value).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function RequestsPage({ onNavigate }: PageProps) {
  const [requests, setRequests] = useState<CustomerRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api.getMyRequests();
      setRequests(data.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We couldn’t load your requests. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <div className="simple-requests">
      <header className="simple-requests-heading">
        <div>
          <h1>My requests</h1>
          <p>Check requests submitted from this browser.</p>
        </div>
        {requests.length > 0 && <button className="btn btn-secondary" onClick={() => onNavigate('inspection')}>New request</button>}
      </header>

      {requests.length > 0 && <div className="simple-requests-toolbar">
        <span>{requests.length} request{requests.length === 1 ? '' : 's'}</span>
        <button onClick={() => void load()} disabled={loading}><RefreshCw size={15} />{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>}

      {error && <div className="simple-requests-error" role="alert">
        <p>{error}</p>
        <button className="btn btn-secondary" onClick={() => void load()}>Try again</button>
      </div>}

      {loading && requests.length === 0 ? <p className="simple-requests-loading" role="status">Loading your requests…</p>
        : !error && requests.length === 0 ? <section className="simple-requests-empty">
          <span className="simple-requests-empty-icon"><FileText size={28} strokeWidth={1.5} /></span>
          <h2>No requests yet</h2>
          <p>Tell us what you’ve noticed to get started.</p>
          <button className="btn btn-primary" onClick={() => onNavigate('inspection')}>Start a request <ArrowRight size={17} /></button>
        </section>
          : <div className="simple-requests-list">
            {requests.map(request => {
              const isOpen = expanded === request.id;
              const location = [request.address, request.postalCode].filter(Boolean).join(', ');
              return <article className="simple-requests-card my-request-card" data-testid="request-card" key={request.id}>
                <div className="simple-requests-card-top">
                  <span className={`simple-requests-status request-status-pill status-${request.status.toLowerCase().replaceAll(' ', '-')}`} data-testid="request-status"><span />{request.status}</span>
                  <time dateTime={request.createdAt}>Submitted {dateLabel(request.createdAt)}</time>
                </div>
                {!isOpen && <p className="simple-requests-summary">{request.description}</p>}
                <p className="simple-requests-next">{statusDescriptions[request.status]}</p>
                <div className="simple-requests-card-bottom">
                  <span className="simple-requests-reference my-request-id">{request.id}</span>
                  <button className="simple-requests-toggle" aria-expanded={isOpen} aria-controls={`details-${request.id}`} onClick={() => setExpanded(isOpen ? null : request.id)}>
                    {isOpen ? 'Hide details' : 'View details'}<ChevronDown size={17} />
                  </button>
                </div>

                {isOpen && <div className="simple-requests-details" id={`details-${request.id}`}>
                  {request.scheduledAt && <section className="simple-requests-appointment">
                    <h2>Your appointment</h2>
                    <p>{new Date(request.scheduledAt).toLocaleString('en-CA', { dateStyle: 'full', timeStyle: 'short' })}</p>
                    {request.assignee && <p>With {request.assignee}</p>}
                  </section>}
                  <section>
                    <h2>What you shared</h2>
                    <p className="simple-requests-description">{request.description}</p>
                    {location && <p className="simple-requests-location"><MapPin size={15} />{location}</p>}
                  </section>
                  {request.attachments.length > 0 && <section>
                    <h2>Photos and videos</h2>
                    <div className="simple-requests-media-grid">
                      {request.attachments.map(attachment => <div className="simple-requests-media" data-testid="request-media" key={attachment.id}>
                        {attachment.type.startsWith('video/')
                          ? <video src={attachment.url} controls playsInline preload="metadata" aria-label={attachment.name} />
                          : ['image/heic', 'image/heif'].includes(attachment.type)
                            ? <div className="simple-requests-media-placeholder"><Camera size={28} /><span>Photo</span></div>
                            : <a href={attachment.url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`}><img src={attachment.url} alt={attachment.name} loading="lazy" /></a>}
                        <a href={attachment.url} target="_blank" rel="noreferrer" className="simple-requests-media-link my-request-attachment" title={attachment.name}>{attachment.name}</a>
                      </div>)}
                    </div>
                  </section>}
                  {request.status === 'Referred' && <button className="btn btn-secondary" onClick={() => onNavigate('contractors')}>Find a specialist <ArrowRight size={16} /></button>}
                </div>}
              </article>;
            })}
          </div>}
      <p className="simple-requests-demo">Demo: no one is contacted.</p>
    </div>
  );
}
