import type { ProjectDetails } from './types';

export const PROJECT_DETAIL_FIELDS = [
  { key: 'company', label: 'Company', maxLength: 120 },
  { key: 'companyContact', label: 'Company contact', maxLength: 180 },
  { key: 'client', label: 'Client', maxLength: 120 },
  { key: 'clientContact', label: 'Client contact', maxLength: 180 },
  { key: 'reference', label: 'Project reference', maxLength: 80 },
  { key: 'preparedBy', label: 'Prepared by', maxLength: 120 },
  { key: 'notes', label: 'Notes', maxLength: 1500 }
] as const;

export function normalizeProjectDetails(value: unknown): ProjectDetails {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid project details.');
  const source = (value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(PROJECT_DETAIL_FIELDS.map((field) => {
    const text = source[field.key] ?? '';
    if (typeof text !== 'string' || text.length > field.maxLength) throw new Error(`Invalid ${field.label.toLowerCase()}.`);
    return [field.key, text.trim()];
  })) as unknown as ProjectDetails;
}
