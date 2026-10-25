import { useEffect, useRef, useState } from 'react';
import { marketplace, type DirectoryResult, type GoogleReviews } from '../lib/marketplace';
import './contractor-directory.css';

const safeUrl = (value?: string) => { try { const url = new URL(value || ''); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; } };
export function Reviews({ placeId }: { placeId: string }) {
  const [data, setData] = useState<GoogleReviews | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; marketplace.reviews(placeId).then(value => { if (active) setData(value); }).catch(cause => { if (active) setError(cause.message); }); return () => { active = false; }; }, [placeId]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p role="status">Loading reviews…</p>;
  return <div className="directory-reviews"><p>{data.rating ? `${data.rating} / 5 · ${data.userRatingCount || 0} reviews` : 'No Google rating yet.'}</p>{!data.reviews?.length && <p>No Google reviews available.</p>}{data.reviews?.map((review, index) => <article key={index}><a href={safeUrl(review.authorAttribution?.uri)} target="_blank" rel="noreferrer">{safeUrl(review.authorAttribution?.photoUri) && <img src={review.authorAttribution!.photoUri} alt="" loading="lazy" referrerPolicy="no-referrer" />} {review.authorAttribution?.displayName || 'Google reviewer'}</a><span>{review.rating} / 5 · {review.relativePublishTimeDescription}</span><p>{review.text?.text}</p><a href={safeUrl(review.googleMapsUri || data.googleMapsUri)} target="_blank" rel="noreferrer">View review on Google Maps</a></article>)}<small>Google supplies a selection of up to five reviews.</small>{data.attributions?.map((source, index) => <a key={index} href={safeUrl(source.uri)} target="_blank" rel="noreferrer">{source.provider}</a>)}<p className="google-attribution" translate="no">Google Maps</p></div>;
}
export default function ContractorDirectory({ postalCode, onSelect }: { postalCode: string; onSelect?: (placeId: string) => void }) {
  const searchVersion = useRef(0);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [data, setData] = useState<DirectoryResult | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => { void marketplace.directoryStatus().then(status => setConfigured(status.configured)).catch(() => setConfigured(null)); }, []);
  useEffect(() => { searchVersion.current++; setData(null); setError(''); setOpened(null); setBusy(false); }, [postalCode]);
  async function search() {
    const version = ++searchVersion.current;
    setBusy(true); setError(''); setOpened(null);
    try { const result = await marketplace.directory(postalCode); if (version === searchVersion.current) setData(result); } catch (cause) { if (version === searchVersion.current) setError(cause instanceof Error ? cause.message : 'Please try again.'); } finally { if (version === searchVersion.current) setBusy(false); }
  }
  return <section className="contractor-directory" aria-label="Nearby mold contractors"><div className="directory-heading"><div><strong>Contractors near you</strong><p>Within 50 km of your Ontario postal code.</p></div><button type="button" className="btn btn-secondary" disabled={busy || !postalCode.trim() || configured === false} onClick={() => void search()}>{busy ? 'Searching…' : 'Find contractors'}</button></div>
    {configured === false && <p className="directory-note">Google directory setup is pending. Your screening will wait for location matching before invitations are sent.</p>}
    {error && <p role="alert">{error}</p>}
    {data && <><p className="directory-note">{data.contractors.length} businesses found · Approximate straight-line distance. A listing does not mean the company is subscribed to MoldLens.{data.truncated ? ' More businesses may be available on Google Maps.' : ''}</p><div className="directory-results">{data.contractors.map(item => <article key={item.placeId}><div className="directory-business-heading"><strong>{item.name}</strong><span>{item.distanceKm} km</span></div><p>{item.address}</p><div className="directory-business-actions"><span>{item.rating === null ? 'No rating yet' : `${item.rating} / 5 · ${item.reviewCount} reviews`}</span><a href={safeUrl(item.mapsUrl)} target="_blank" rel="noreferrer">Google Maps ↗</a><button type="button" onClick={() => setOpened(opened === item.placeId ? null : item.placeId)} aria-expanded={opened === item.placeId}>Reviews</button></div>{onSelect && <button type="button" className="market-text-button" onClick={() => onSelect(item.placeId)}>Use this business profile</button>}{opened === item.placeId && <Reviews placeId={item.placeId} />}{item.attributions.map((source, index) => <a key={index} href={safeUrl(source.uri)} target="_blank" rel="noreferrer">{source.provider}</a>)}</article>)}</div><p className="google-attribution" translate="no">Google Maps</p><p className="directory-note">Live Google business information. <a href="/directory-terms.html" target="_blank" rel="noreferrer">Directory terms & privacy</a></p></>}
  </section>;
}
