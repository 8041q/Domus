import type { ClientContact, ProjectDetails } from './types';

export const PROJECT_DETAIL_FIELDS = [
  { key: 'company', label: 'Company', maxLength: 120 },
  { key: 'companyContact', label: 'Company contact', maxLength: 180 },
  { key: 'client', label: 'Client', maxLength: 120 },
  { key: 'clientContact', label: 'Client contact', maxLength: 180 },
  { key: 'reference', label: 'Project', maxLength: 80 },
  { key: 'preparedBy', label: 'Prepared by', maxLength: 120 },
  { key: 'revision', label: 'Revision', maxLength: 80 },
  { key: 'status', label: 'Status', maxLength: 20 },
  { key: 'roomPurpose', label: 'Room purpose', maxLength: 120 },
  { key: 'location', label: 'Site', maxLength: 180 },
  { key: 'notes', label: 'Notes', maxLength: 1500 }
] as const;
export const PROJECT_STATUSES = ['', 'Draft', 'In review', 'Approved'] as const;

export const MAX_CLIENT_CONTACTS = 20;
const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeContact(value: unknown): ClientContact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid client contact.');
  const source = value as Record<string, unknown>;
  const result = Object.fromEntries(([['name', 180], ['phone', 80], ['email', 254]] as const).map(([key, limit]) => {
    const text = source[key] ?? '';
    if (typeof text !== 'string' || text.length > Number(limit)) throw new Error(`Invalid client contact ${key}.`);
    return [key, text.trim()];
  })) as unknown as ClientContact;
  if (result.email && !validEmail.test(result.email)) throw new Error('Enter a valid client contact email.');
  return result;
}

export function normalizeProjectDetails(value: unknown): ProjectDetails {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid project details.');
  const source = (value ?? {}) as Record<string, unknown>;
  const details = Object.fromEntries(PROJECT_DETAIL_FIELDS.map((field) => {
    const text = source[field.key] ?? '';
    if (typeof text !== 'string' || text.length > field.maxLength) throw new Error(`Invalid ${field.label.toLowerCase()}.`);
    if (field.key === 'status' && !(PROJECT_STATUSES as readonly string[]).includes(text.trim())) throw new Error('Invalid project status.');
    return [field.key, text.trim()];
  })) as unknown as ProjectDetails;
  if (source.clientContacts !== undefined) {
    if (!Array.isArray(source.clientContacts) || source.clientContacts.length > MAX_CLIENT_CONTACTS) throw new Error('Invalid client contacts.');
    details.clientContacts = source.clientContacts.map(normalizeContact).filter(contact => contact.name || contact.phone || contact.email);
    details.clientContact = '';
  } else if (details.clientContact) {
    const legacy = details.clientContact;
    details.clientContacts = [{ name: validEmail.test(legacy) ? '' : legacy, phone: '', email: validEmail.test(legacy) ? legacy : '' }];
    if (legacy.length <= 80 && /^[+()\d\s.\-]+$/.test(legacy) && /\d/.test(legacy)) details.clientContacts = [{ name: '', phone: legacy, email: '' }];
    details.clientContact = '';
  }
  return details;
}
