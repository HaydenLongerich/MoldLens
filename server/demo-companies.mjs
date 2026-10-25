// Real businesses, independently sourced from their own websites. These points
// are approximate city test fixtures, not geocoded or verified office locations.
export const demoLocations = [
  { city: 'Newmarket', letter: 'N', postalCode: 'L3Y 1A1', lat: 44.0592, lng: -79.4613 },
  { city: 'Mississauga', letter: 'M', postalCode: 'L4W 5A8', lat: 43.657, lng: -79.615 },
  { city: 'Oakville', letter: 'O', postalCode: 'L6J 6Z1', lat: 43.49, lng: -79.667 },
  { city: 'Toronto', letter: 'T', postalCode: 'M6R 3B9', lat: 43.655, lng: -79.451 },
  { city: 'London', letter: 'L', postalCode: 'N6G 2N3', lat: 43.032, lng: -81.293 },
  { city: 'Ottawa', letter: 'O', postalCode: 'K1P 1J1', lat: 45.4215, lng: -75.6972 },
];
const businesses = [
  { id: 'moldtech', name: 'MoldTech_N', businessName: 'MoldTech', initials: 'MT', phone: '1-866-684-7684', website: 'https://www.moldtech.ca/newmarket', sourceUrl: 'https://www.moldtech.ca/contact', services: ['Mold inspection', 'Mold removal'] },
  { id: 'kleen', name: 'KleenCondition_M', businessName: 'Kleen Condition', initials: 'KC', phone: '416-919-2093', website: 'https://kleencondition.com/', sourceUrl: 'https://kleencondition.com/locations/', services: ['Mold removal', 'Asbestos removal'] },
  { id: 'ultrafree', name: 'UltraFreeMold_O', businessName: 'UltraFreeMold', initials: 'UF', phone: '647-559-4879', website: 'https://www.ultrafreemold.com/', sourceUrl: 'https://www.ultrafreemold.com/contact-us', services: ['Mold testing', 'Mold removal'] },
  { id: 'moldguy', name: 'TheMoldGuy_T', businessName: 'The Mold Guy', initials: 'MG', phone: '416-333-2999', website: 'https://www.moldguy.ca/', sourceUrl: 'https://www.moldguy.ca/contact-us/', services: ['Mold inspection', 'Mold removal'] },
  { id: 'lets', name: 'LETS_L', businessName: 'London Environmental Testing Services', initials: 'LE', phone: '226-646-4144', website: 'https://londonenvironmental.ca/', sourceUrl: 'https://londonenvironmental.ca/contact-us.php', services: ['Mold inspection', 'Mold testing'] },
  { id: 'moldbusters', name: 'MoldBusters_O', businessName: 'Mold Busters', initials: 'MB', phone: '613-262-3242', website: 'https://www.bustmold.com/locations/ottawa/', sourceUrl: 'https://www.bustmold.com/locations/ottawa/', services: ['Mold inspection', 'Mold removal'] },
];
export const exampleCompanies = businesses.map((business, index) => ({ ...business, ...demoLocations[index], demoLocation: { lat: demoLocations[index].lat, lng: demoLocations[index].lng }, description: `${business.businessName} · ${demoLocations[index].city} demo workspace. Approximate test location.`, example: true, subscription: 'pending', trialEndsAt: null, membership: { status: 'pending', amount: 100, currency: 'CAD', interval: 'month', simulated: true } }));
