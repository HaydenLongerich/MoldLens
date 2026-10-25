import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { areasOf, type MarketReport } from '../lib/marketplace';

export default function ProjectReview({ report, onQuote, children }: { report: MarketReport; onQuote?: () => void; children?: ReactNode }) {
  const areas = areasOf(report);
  const grouped = new Set(areas.flatMap(area => area.findings));
  const additional = (report.findings || []).filter(finding => !grouped.has(finding));
  return <section className="market-panel project-review">
    <div className="project-scope"><strong>Whole-project scope</strong><span>{areas.length} area{areas.length === 1 ? '' : 's'} · one project quote</span></div>
    {report.description && <p className="market-description">{report.description}</p>}
    {(report.summary || report.summaryPoints?.length || additional.length || report.recommendations?.length) && <section className="project-screening-summary"><h3>Screening summary</h3>{report.summary && <p>{report.summary}</p>}{!!report.summaryPoints?.length && <ul>{report.summaryPoints.map((point, index) => <li key={index}>{point}</li>)}</ul>}{additional.length > 0 && <ul>{additional.map((finding, index) => <li key={index}>{finding}</li>)}</ul>}{!!report.recommendations?.length && <><h3>Recommended next steps</h3><ul>{report.recommendations.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</section>}
    <div className="project-areas-heading"><h3>Project areas</h3></div>
    <div className="project-area-list">{areas.map(area => <article key={area.id} className="project-area-flat"><h4>{area.label}</h4>{area.description && <p>{area.description}</p>}{area.findings.length > 0 && <ul>{area.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul>}</article>)}</div>
    {onQuote && <button className="btn btn-primary project-quote-action" onClick={onQuote}>Quote entire project<ArrowRight size={16} /></button>}
    {children}
  </section>;
}
