import path from 'node:path';
import { HttpError } from './validation.mjs';

export function postalCode(value) {
  const code = String(value || '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[KLMNP][0-9][ABCEGHJ-NPRSTV-Z][0-9][ABCEGHJ-NPRSTV-Z][0-9]$/.test(code)) throw new HttpError(400, 'Enter a valid Ontario postal code.');
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
export function distanceKm(a, b) {
  const rad = n => n * Math.PI / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export const withinRadius = (a, b) => Boolean(a && b && Number.isFinite(a.lat) && Number.isFinite(a.lng) && Number.isFinite(b.lat) && Number.isFinite(b.lng) && distanceKm(a, b) <= 50);

// Only IDs and our own indexing metadata are persisted. Google names, reviews,
// ratings and business coordinates are fetched live and never copied into this DB.
export function createDirectory({ dataDirectory, apiKey = process.env.GOOGLE_MAPS_API_KEY, fetcher = fetch, resolvePostal } = {}) {
  let database;
  let closing;
  const geocodes = new Map();
  const pending = new Map();
  const configured = Boolean(apiKey || resolvePostal);
  async function db() {
    if (!database) database = (async () => {
      const { PGlite } = await import('@electric-sql/pglite');
      const handle = new PGlite(path.join(dataDirectory, 'contractor-directory-db'));
      await handle.exec('CREATE TABLE IF NOT EXISTS google_place_index (place_id text PRIMARY KEY, first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(), search_region text NOT NULL)');
      return handle;
    })();
    return database;
  }
  async function google(url, options = {}) {
    let response;
    try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000) }); }
    catch { throw new HttpError(503, 'Location search is temporarily unavailable. Please try again.'); }
    if (!response.ok) throw new HttpError(503, 'Google location search is unavailable. Check the server API configuration.');
    return response.json();
  }
  async function locate(value) {
    const code = postalCode(value);
    if (resolvePostal) return resolvePostal(code);
    if (!apiKey) throw new HttpError(503, 'Postal-code matching is waiting for Google Maps setup. Your screening can still be saved.');
    const cached = geocodes.get(code);
    if (cached?.expires > Date.now()) return cached.location;
    if (pending.has(code)) return pending.get(code);
    const work = (async () => {
      const query = new URLSearchParams({ components: `postal_code:${code}|country:CA|administrative_area:ON`, key: apiKey });
      const result = await google(`https://maps.googleapis.com/maps/api/geocode/json?${query}`);
      const place = result.results?.find(item => !item.partial_match && item.address_components?.some(c => c.types.includes('administrative_area_level_1') && c.short_name === 'ON') && item.address_components.some(c => c.types.includes('country') && c.short_name === 'CA') && item.address_components.some(c => c.types.includes('postal_code') && c.long_name.replace(/\s/g, '') === code.replace(/\s/g, '')));
      if (result.status !== 'OK' || !place) throw new HttpError(400, 'We could not locate that Ontario postal code. Check it and try again.');
      const location = { lat: place.geometry.location.lat, lng: place.geometry.location.lng };
      if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) throw new HttpError(503, 'Location search returned an invalid position.');
      // In-memory only, comfortably below Google's permitted coordinate cache window.
      if (geocodes.size >= 5000) geocodes.clear();
      geocodes.set(code, { location, expires: Date.now() + 24 * 60 * 60 * 1000 });
      return location;
    })();
    pending.set(code, work);
    try { return await work; } finally { pending.delete(code); }
  }
  async function remember(places, region) {
    const handle = await db();
    for (const item of places) if (typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(item.id)) await handle.query('INSERT INTO google_place_index(place_id,search_region) VALUES ($1,$2) ON CONFLICT(place_id) DO UPDATE SET last_seen=now()', [item.id, region]);
  }
  async function search(value) {
    const code = postalCode(value);
    const centre = await locate(code);
    if (!apiKey) throw new HttpError(503, 'Google business search is waiting for setup.');
    const latDelta = 50 / 110.574, lngDelta = 50 / (111.32 * Math.cos(centre.lat * Math.PI / 180));
    const found = new Map();
    let truncated = false;
    for (const category of ['mold removal', 'mold inspection and testing']) {
      let pageToken;
      for (let page = 0; page < 3; page++) {
        const body = { textQuery: `${category} contractors`, regionCode: 'CA', languageCode: 'en', pageSize: 20,
          locationRestriction: { rectangle: { low: { latitude: centre.lat - latDelta, longitude: centre.lng - lngDelta }, high: { latitude: centre.lat + latDelta, longitude: centre.lng + lngDelta } } }, ...(pageToken ? { pageToken } : {}) };
        const data = await google('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.businessStatus,places.attributions,nextPageToken' }, body: JSON.stringify(body) });
        await remember(data.places || [], code.slice(0, 3));
        for (const place of data.places || []) {
          const location = { lat: place.location?.latitude, lng: place.location?.longitude };
          const ontario = place.addressComponents?.some(c => c.types.includes('administrative_area_level_1') && c.shortText === 'ON');
          if (ontario && place.businessStatus !== 'CLOSED_PERMANENTLY' && withinRadius(centre, location)) found.set(place.id, { placeId: place.id, name: place.displayName?.text || 'Contractor', address: place.formattedAddress, rating: place.rating ?? null, reviewCount: place.userRatingCount || 0, mapsUrl: place.googleMapsUri, distanceKm: Math.round(distanceKm(centre, location) * 10) / 10, attributions: place.attributions || [] });
        }
        pageToken = data.nextPageToken;
        if (!pageToken) break;
        if (page === 2) truncated = true;
      }
    }
    return { postalCode: code, radiusKm: 50, contractors: [...found.values()].sort((a, b) => a.distanceKm - b.distanceKm), truncated, source: 'Google Maps', fetchedAt: new Date().toISOString() };
  }
  async function reviews(id) {
    if (!apiKey) throw new HttpError(503, 'Google reviews are waiting for setup.');
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(id)) throw new HttpError(400, 'Invalid business ID.');
    const known = await (await db()).query('SELECT place_id FROM google_place_index WHERE place_id=$1', [id]);
    if (!known.rows.length) throw new HttpError(404, 'Find this business in the directory first.');
    return google(`https://places.googleapis.com/v1/places/${id}`, { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,reviews,googleMapsUri,attributions' } });
  }
  async function known(id) {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(id)) return false;
    return Boolean((await (await db()).query('SELECT place_id FROM google_place_index WHERE place_id=$1', [id])).rows.length);
  }
  // Used by the explicitly invoked, bounded Ontario index command. No scheduled bulk scraping.
  async function indexQuery(query, pageToken) {
    if (!apiKey) throw new Error('Configure GOOGLE_MAPS_API_KEY first.');
    const result = await google('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,nextPageToken' }, body: JSON.stringify({ textQuery: query, regionCode: 'CA', pageSize: 20, ...(pageToken ? { pageToken } : {}) }) });
    await remember(result.places || [], 'Ontario');
    return { count: result.places?.length || 0, nextPageToken: result.nextPageToken };
  }
  return { configured, googleConfigured: Boolean(apiKey), locate, search, reviews, known, indexQuery, async close() { if (database) return closing ||= (async () => { await (await database).close(); })(); } };
}
