import { applyAiProposal, snapshotRevision } from '../core/aiProposal';
import { PRODUCTS } from '../core/products';
import type { PlannerSnapshot } from '../core/types';
import type { AiOperation, AiProposal } from './types';

export function proposalIssue(snapshot: PlannerSnapshot, proposal: AiProposal) {
  if (snapshotRevision(snapshot) !== proposal.baseRevision) return 'The room changed. Request an updated proposal before applying it.';
  const error = applyAiProposal(snapshot, proposal).error;
  if (!error) return null;
  if (/position|overlap|wall|room/.test(error)) return 'This arrangement does not fit the current room. Ask for another option; nothing has changed.';
  if (/no longer exists|unknown/.test(error)) return 'An item is no longer available. Ask for an updated proposal; nothing has changed.';
  return 'This proposal could not be validated. Ask for a revised version; nothing has changed.';
}

export function operationDescription(operation: AiOperation, snapshot: PlannerSnapshot) {
  const all = [...snapshot.objects, ...snapshot.unplacedObjects];
  const object = all.find(item => item.id === operation.objectId);
  const productId = object?.productId ?? operation.productId;
  const product = productId ? PRODUCTS[productId] : undefined;
  const duplicates = all.filter(item => item.productId === productId);
  const suffix = object && duplicates.length > 1 ? ` ${duplicates.findIndex(item => item.id === object.id) + 1}` : '';
  const name = `${product?.name ?? 'Furniture item'}${suffix}`;
  if (operation.type === 'remove-object') return `Remove ${name}`;
  if (operation.type === 'add-object') return `Add ${name}`;
  if (operation.type === 'rotate-object') return `Rotate ${name} to ${Math.round(operation.rotationDegrees)}°`;
  return `Move ${name} to ${operation.x.toFixed(2)}, ${operation.z.toFixed(2)} m`;
}
