export type ResourceKind = 'TISCH' | 'PARKPLATZ' | 'RAUM' | 'SONSTIGES';

export const RESOURCE_KIND_OPTIONS: Array<{ value: ResourceKind; label: string }> = [
  { value: 'TISCH', label: 'Tisch' },
  { value: 'PARKPLATZ', label: 'Parkplatz' },
  { value: 'RAUM', label: 'Raum' },
  { value: 'SONSTIGES', label: 'Ressource' }
];

export function resourceKindLabel(kind?: string): 'Tisch' | 'Parkplatz' | 'Raum' | 'Ressource' {
  if (kind === 'TISCH') return 'Tisch';
  if (kind === 'PARKPLATZ') return 'Parkplatz';
  if (kind === 'RAUM') return 'Raum';
  return 'Ressource';
}
