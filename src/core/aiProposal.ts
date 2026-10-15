import { createId } from './id';
import type { AiOperation, AiProposal } from '../ai/types';
import { PRODUCTS } from './products';
import { isPlacementValid } from './placement';
import { architectureRoom } from './spaces';
import type { PlacedObject, PlannerSnapshot, ProductKind } from './types';
import { MAX_AI_REMOVALS } from '../ai/removalIntent';

export function snapshotRevision(snapshot: PlannerSnapshot) {
  const value = JSON.stringify(snapshot);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function finite(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= 1000;
}

function radians(degrees: number) {
  return ((degrees % 360) + 360) % 360 * Math.PI / 180;
}

function validateCandidate(candidate: PlacedObject, snapshot: PlannerSnapshot) {
  if (!isPlacementValid(candidate, architectureRoom(snapshot), snapshot.objects.filter((object) => object.id !== candidate.id))) {
    return 'The proposed position intersects a wall, leaves the room, or overlaps another item.';
  }
  return null;
}

function applyOperation(snapshot: PlannerSnapshot, operation: AiOperation, index: number): string | null {
  const prefix = `Operation ${index + 1}`;
  if (!['add-object', 'remove-object', 'move-object', 'rotate-object'].includes(operation.type)) return `${prefix} has an unsupported action.`;
  if (operation.type !== 'remove-object' && (!finite(operation.rotationDegrees)
    || (operation.type !== 'rotate-object' && (!finite(operation.x) || !finite(operation.z))))) return `${prefix} contains an invalid number.`;

  if (operation.type === 'add-object') {
    if (!operation.productId || !Object.hasOwn(PRODUCTS, operation.productId)) return `${prefix} uses an unknown catalogue product.`;
    const candidate: PlacedObject = {
      id: `ai-${operation.productId}-${createId()}`,
      productId: operation.productId as ProductKind,
      x: operation.x,
      z: operation.z,
      rotationY: radians(operation.rotationDegrees)
    };
    snapshot.objects.push(candidate);
    return null;
  }

  const objectIndex = snapshot.objects.findIndex((object) => object.id === operation.objectId);
  if (operation.type === 'remove-object') {
    const unplacedIndex = snapshot.unplacedObjects.findIndex(object => object.id === operation.objectId);
    if (objectIndex < 0 && unplacedIndex < 0) return `${prefix} references an item that no longer exists.`;
    if (objectIndex >= 0) snapshot.objects.splice(objectIndex, 1);
    if (unplacedIndex >= 0) snapshot.unplacedObjects.splice(unplacedIndex, 1);
    return null;
  }
  if (objectIndex < 0) return `${prefix} references an item that no longer exists.`;

  const current = snapshot.objects[objectIndex];
  const candidate: PlacedObject = operation.type === 'move-object'
    ? { ...current, x: operation.x, z: operation.z, rotationY: radians(operation.rotationDegrees) }
    : { ...current, rotationY: radians(operation.rotationDegrees) };
  snapshot.objects[objectIndex] = candidate;
  return null;
}

export function applyAiProposal(snapshot: PlannerSnapshot, proposal: AiProposal) {
  if (!proposal.operations.length) return { snapshot, error: 'The proposal does not contain any changes.' };
  if (proposal.operations.length > (proposal.operations.every(operation => operation.type === 'remove-object') ? MAX_AI_REMOVALS : 8)) return { snapshot, error: 'This proposal has too many changes. Ask for a smaller group of changes.' };
  const next = structuredClone(snapshot) as PlannerSnapshot;
  for (const [index, operation] of proposal.operations.entries()) {
    const error = applyOperation(next, operation, index);
    if (error) return { snapshot, error };
  }
  const originalIds = new Set(snapshot.objects.map(object => object.id));
  const changedIds = new Set(proposal.operations.filter(operation => operation.type !== 'remove-object').map(operation => operation.objectId));
  // Validate the final arrangement rather than temporary intermediate positions.
  // This permits swaps and moves into a position another operation clears.
  for (const object of next.objects) {
    if (!originalIds.has(object.id) || changedIds.has(object.id)) {
      const error = validateCandidate(object, next);
      if (error) return { snapshot, error };
    }
  }
  return { snapshot: next, error: null };
}
