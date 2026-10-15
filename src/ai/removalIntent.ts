import type { PlannerSnapshot } from '../core/types';
import type { AiProposal } from './types';

export const MAX_AI_REMOVALS = 128;

/** Only unambiguous removal commands are handled locally. Questions, negations
 * and mixed requests still go to the assistant for advice/clarification. */
export function explicitRemoval(text: string, snapshot: PlannerSnapshot, catalog: Array<{ id: string; name: string }>) {
  const command = text.toLowerCase().trim().replace(/[.!?]+$/, '')
    .replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/, '').replace(/\s+please$/, '');
  const match = /^(?:remove|delete|clear|take out|get rid of)\s+(.+)$/.exec(command);
  if (!match || /\b(and|but|except|keep|not|don't|without)\b/.test(match[1])) return null;
  const target = match[1].replace(/\s+(?:from|in) (?:the |my )?room$/, '').replace(/^(?:all(?: of)?\s+)?(?:the |my )?/, '').trim();
  const all = /^(?:furniture|items|objects|everything|room|all)$/.test(target) || match[1] === 'all';
  const names = new Map(catalog.map(item => [item.id, item.name.toLowerCase()]));
  const normalize = (value: string) => value.replace(/\b([a-z]{3,})s\b/g, '$1');
  const items = [...(snapshot.objects ?? []), ...(snapshot.unplacedObjects ?? [])];
  const selected = all ? items : items.filter(item => normalize(names.get(item.productId) ?? '').includes(normalize(target)));
  if (!selected.length && !all) return null;
  if (!all && selected.length > 1 && !/^all\b/.test(match[1])) return { ids: [], message: 'There is more than one matching item. Specify which one, or ask to remove all of them.' };
  return { ids: selected.map(item => item.id), message: selected.length ? '' : 'There are no matching furniture items to remove.' };
}

export function removalProposal(text: string, snapshot: PlannerSnapshot, catalog: Array<{ id: string; name: string }>, revision: string): { message: string; proposal: AiProposal | null } | null {
  const removal = explicitRemoval(text, snapshot, catalog);
  if (!removal) return null;
  if (removal.message) return { message: removal.message, proposal: null };
  if (removal.ids.length > MAX_AI_REMOVALS) return { message: 'Please remove furniture in smaller groups.', proposal: null };
  const summary = `Remove ${removal.ids.length} furniture item${removal.ids.length === 1 ? '' : 's'}`;
  return { message: 'Review the removal below. Your room has not changed.', proposal: {
    baseRevision: revision, summary, operations: removal.ids.map(objectId => ({ type: 'remove-object', objectId, productId: '', x: 0, z: 0, rotationDegrees: 0 }))
  } };
}
