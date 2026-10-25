// Run with the app stopped: PGlite permits one process per data directory.
import path from 'node:path';
import { createDirectory } from '../server/contractor-directory.mjs';

const cities = ['Toronto', 'Ottawa', 'Mississauga', 'Brampton', 'Hamilton', 'London', 'Markham', 'Vaughan', 'Richmond Hill', 'Newmarket', 'Aurora', 'East Gwillimbury', 'Barrie', 'Orillia', 'Oshawa', 'Whitby', 'Ajax', 'Pickering', 'Oakville', 'Burlington', 'Milton', 'Kitchener', 'Waterloo', 'Cambridge', 'Guelph', 'Brantford', 'Niagara Falls', 'St. Catharines', 'Welland', 'Windsor', 'Chatham', 'Sarnia', 'Woodstock', 'Stratford', 'Owen Sound', 'Collingwood', 'Orangeville', 'Peterborough', 'Kawartha Lakes', 'Belleville', 'Trenton', 'Kingston', 'Brockville', 'Cornwall', 'Pembroke', 'Huntsville', 'Bracebridge', 'Parry Sound', 'North Bay', 'Greater Sudbury', 'Sault Ste. Marie', 'Timmins', 'Thunder Bay', 'Kenora', 'Dryden', 'Fort Frances'];
const capArg = process.argv.find(value => value.startsWith('--max-requests='));
const cap = Number(capArg?.split('=')[1]);
if (!Number.isInteger(cap) || cap < 1 || cap > 500) throw new Error('Provide --max-requests=1..500 to explicitly bound billable Google API requests. No requests have been made.');
if (!process.env.GOOGLE_MAPS_API_KEY) throw new Error('Set GOOGLE_MAPS_API_KEY on the server. No requests have been made.');
const dataDirectory = process.env.MOLDLENS_DATA_DIR || path.resolve('data');
const directory = createDirectory({ dataDirectory });
let requests = 0;
try {
  outer: for (const city of cities) for (const service of ['mold remediation contractors', 'mold inspection testing companies']) {
    let token;
    for (let page = 0; page < 3; page++) {
      if (requests >= cap) break outer;
      const result = await directory.indexQuery(`${service} in ${city}, Ontario, Canada`, token);
      requests++;
      console.log(`${city}: ${result.count} IDs indexed (${requests}/${cap} requests).`);
      token = result.nextPageToken;
      if (!token) break;
    }
  }
  console.log('Index complete. Only Place IDs and indexing metadata were saved; coverage is not exhaustive. Ratings and reviews are fetched live in the directory.');
} finally { await directory.close(); }
