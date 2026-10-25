import { useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronDown } from 'lucide-react';
import { areasOf, type MarketReport } from '../lib/marketplace';

export default function ProjectReview({ report, reviewerId, onQuote, children }: { report: MarketReport; reviewerId?: string; onQuote?: () => void; children?: ReactNode }) {
  const areas = areasOf(report);
  const [selectedArea, setSelectedArea] = useState('all');
  const storageKey = `moldlens-reviewed:${reviewerId}:${report.id}`;
  const [reviewed, setReviewed] = useState<string[]>(() => { try { const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]'); return Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []; } catch { return []; } });
  function toggleReview(id: string) { const next = reviewed.includes(id) ? reviewed.filter(value => value !== id) : [...reviewed, id]; setReviewed(next); try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Review remains available in memory. */ } }
  const grouped = new Set(areas.flatMap(area => area.findings));
  const additional = (report.findings || []).filter(finding => !grouped.has(finding));
  return <section className="market-panel project-review">
    <div className="project-scope"><strong>Whole-project scope</strong><span>{areas.length} area{areas.length === 1 ? '' : 's'} · one project quote</span></div>
    {report.description && <p className="market-description">{report.description}</p>}
    {(report.summary || report.summaryPoints?.length || additional.length || report.recommendations?.length) && <details className="project-summary"><summary>Screening summary<ChevronDown size={16} /></summary><div>{report.summary && <p>{report.summary}</p>}{!!report.summaryPoints?.length && <ul>{report.summaryPoints.map((point, index) => <li key={index}>{point}</li>)}</ul>}{additional.length > 0 && <ul>{additional.map((finding, index) => <li key={index}>{finding}</li>)}</ul>}{!!report.recommendations?.length && <><h3>Recommended next steps</h3><ul>{report.recommendations.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</div></details>}
    <div className="project-areas-heading"><h3>Project areas</h3>{reviewerId && <span>{areas.filter(area => reviewed.includes(area.id)).length}/{areas.length} reviewed</span>}</div>
    <div className="project-area-filter" aria-label="Review project areas"><button aria-pressed={selectedArea === 'all'} onClick={() => setSelectedArea('all')}>All areas</button>{areas.map(area => <button key={area.id} aria-pressed={selectedArea === area.id} onClick={() => setSelectedArea(area.id)}>{area.label}{reviewerId && reviewed.includes(area.id) && <Check size={12} />}</button>)}</div>
    <div className="project-area-list">{areas.filter(area => selectedArea === 'all' || selectedArea === area.id).map(area => <details key={area.id} className="project-area" open={selectedArea !== 'all' || undefined}><summary><span><strong>{area.label}</strong><small>{area.findings.length ? `${area.findings.length} screening finding${area.findings.length === 1 ? '' : 's'}` : 'Assessment needed'}</small></span><ChevronDown size={17} /></summary><div>{area.description && <p>{area.description}</p>}{area.findings.length ? <ul>{area.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul> : <p className="market-small">No area-specific findings recorded.</p>}{reviewerId && <button className={`project-reviewed${reviewed.includes(area.id) ? ' is-reviewed' : ''}`} aria-pressed={reviewed.includes(area.id)} onClick={() => toggleReview(area.id)}><Check size={15} />{reviewed.includes(area.id) ? 'Reviewed' : 'Mark reviewed'}</button>}</div></details>)}</div>
    {onQuote && <button className="btn btn-primary project-quote-action" onClick={onQuote}>Quote entire project<ArrowRight size={16} /></button>}
    {children}
  </section>;
}
