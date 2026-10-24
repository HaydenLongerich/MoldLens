import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleRoot = fileURLToPath(new URL('../public/sample-data/', import.meta.url));

export async function loadSeeds() {
  const configurations = [
    { directory: '01_OnSite_Sample', id: 'MB-CASE01', name: 'On-site sample', propertyType: 'House', area: 'Basement, washrooms & attic', relationship: 'Homeowner', createdAt: '2026-10-01T13:00:00.000Z', updatedAt: '2026-10-22T20:33:00.000Z', report: 'Report_OnSite_Sample.pdf', notes: [
      'Imported from the de-identified hackathon pack. The creation date uses the Oct 1 calendar record; the source also mentions Sept 5. In review is a prototype workflow mapping: the source estimate was viewed but not accepted. Medium priority is a demo workflow default, not a clinical risk assessment.',
      'Inspector attribution differs between the report (Staff A) and the estimate systems (Staff B). Confirm before assigning a specialist.',
    ], discrepancies: ['Booking record created Oct 1; the note says booked Sept 5. Both dates remain in the source.', 'Report lists Staff A as the inspector; FreshBooks, Asana and Close list Staff B for the estimate. Assignment needs confirmation.', 'The sample brief flags timezone inconsistencies. Source times remain as recorded in Eastern time. Date-only entries have no verified clock time; the prototype creation time is a placeholder.'] },
    { directory: '02_Virtual_Sample', id: 'MB-CASE02', name: 'Virtual sample', propertyType: 'Apartment', area: 'Laundry & ventilation', relationship: 'Tenant', createdAt: '2025-09-07T13:30:00.000Z', updatedAt: '2025-09-27T16:00:00.000Z', report: 'Report_Virtual_Sample.pdf', notes: [
      'Imported with 3 source stills and a silent walkthrough. Discoloration was visible, but fungal growth was not confirmed by sampling. In review is a prototype mapping: the IAQ estimate was viewed and not accepted. Medium priority is a demo workflow default, not a clinical risk assessment.',
      'The historical virtual assessment cost $100 including tax. This is a 2025 case amount, not the current public offer. The Sep 27 follow-up is date-only; the prototype update time is a placeholder.',
    ], discrepancies: ['The low-resolution walkthrough cannot establish mold type or diagnosis; the reference report recommends professional sampling.', 'Historical case amounts are not current service prices. The sample pack does not include live availability or CRM access.', 'The recorded final follow-up date has no clock time; the prototype update time is a placeholder.'] },
  ];

  return Promise.all(configurations.map(async (config) => {
    const sourcePath = path.join(sampleRoot, config.directory);
    const timeline = JSON.parse(await readFile(path.join(sourcePath, 'job_timeline.json'), 'utf8'));
    const attachments = [];
    for (const folder of ['Photos', 'Videos']) {
      let names;
      try { names = await readdir(path.join(sourcePath, folder)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const name of names.sort()) {
        if (!/\.(jpg|mp4)$/i.test(name)) continue;
        const info = await stat(path.join(sourcePath, folder, name));
        attachments.push({ id: `${config.id}-${attachments.length + 1}`, name, type: name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', size: info.size, url: `/sample-data/${config.directory}/${folder}/${encodeURIComponent(name)}` });
      }
    }
    return {
      id: config.id, name: config.name, email: '', phone: '', address: timeline.property, postalCode: '',
      propertyType: config.propertyType, area: config.area, size: 'Not recorded', duration: 'Not recorded',
      relationship: config.relationship, description: timeline.client_concern, signs: config.id === 'MB-CASE01' ? ['Visible discoloration', 'Moisture concerns'] : ['Visible discoloration', 'Musty odour'],
      contactPreference: 'Not recorded', consent: false, status: 'In review', priority: 'Medium', assignee: '', scheduledAt: '',
      createdAt: config.createdAt, updatedAt: config.updatedAt, isDemo: true, attachments,
      notes: config.notes.map((text, index) => ({ id: `${config.id}-note-${index}`, text, createdAt: config.updatedAt })),
      source: { label: 'Mold Busters hackathon sample', reportUrl: `/sample-data/${config.directory}/${config.report}`, storyUrl: `/sample-data/${config.directory}/Job_Story.pdf`, timelineUrl: `/sample-data/${config.directory}/job_timeline.json`, pricePaid: timeline.price_paid, estimate: timeline.estimate.amount, findings: timeline.findings, recommendations: timeline.recommendations, timeline: timeline.timeline, discrepancies: config.discrepancies },
    };
  }));
}
