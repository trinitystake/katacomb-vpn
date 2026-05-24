// Natural Earth 110m uses abbreviated names for a handful of countries;
// the dVPN node data uses the conventional long form. Map polygon-name
// -> data-name so the count lookup hits. Ported verbatim from meile-gui's
// map.html. Only the 17 entries that actually clash are listed.
export const POLY_TO_PIN: Record<string, string> = {
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Central African Rep.': 'Central African Republic',
  'Congo': 'Republic of the Congo',
  'Czechia': 'Czech Republic',
  "Côte d'Ivoire": 'Ivory Coast',
  'Dem. Rep. Congo': 'Democratic Republic of the Congo',
  'Dominican Rep.': 'Dominican Republic',
  'Eq. Guinea': 'Equatorial Guinea',
  'Falkland Is.': 'Falkland Islands',
  'S. Sudan': 'South Sudan',
  'Solomon Is.': 'Solomon Islands',
  'Timor-Leste': 'East Timor',
  'United States of America': 'United States',
  'W. Sahara': 'Western Sahara',
  'eSwatini': 'Swaziland',
  'Macedonia': 'North Macedonia',
  'Turkey': 'Türkiye',
}

export interface PolyFeature {
  properties?: { name?: string }
}

export function polyKey(feature: PolyFeature): string {
  const n = feature?.properties?.name
  if (!n) return ''
  return POLY_TO_PIN[n] ?? n
}
