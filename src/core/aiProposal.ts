import type { AiOperation, AiProposal } from '../ai/types';
import { PRODUCTS } from './products';
import { isPlacementValid } from './placement';
import type { PlacedObject, PlannerSnapshot, ProductKind } from './types';

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
  if (!isPlacementValid(candidate, snapshot.room, snapshot.objects.filter((object) => object.id !== candidate.id))) {
    return 'The proposed position intersects a wall, leaves the room, or overlaps another item.';
  }
  return null;
}

function applyOperation(snapshot: PlannerSnapshot, operation: AiOperation, index: number): string | null {
  const prefix = `Operation ${index + 1}`;
  if (!finite(operation.x) || !finite(operation.z) || !finite(operation.rotationDegrees)) return `${prefix} contains an invalid number.`;

  if (operation.type === 'add-object') {
    if (!operation.productId || !(operation.productId in PRODUCTS)) return `${prefix} uses an unknown catalogue product.`;
    const candidate: PlacedObject = {
      id: `ai-${operation.productId}-${crypto.randomUUID().slice(0, 8)}`,
      productId: operation.productId as ProductKind,
      x: operation.x,
      z: operation.z,
      rotationY: radians(operation.rotationDegrees)
    };
    const error = validateCandidate(candidate, snapshot);
    if (error) return `${prefix}: ${error}`;
    snapshot.objects.push(candidate);
    return null;
  }

  const objectIndex = snapshot.objects.findIndex((object) => object.id === operation.objectId);
  if (objectIndex < 0) return `${prefix} references an item that no longer exists.`;
  if (operation.type === 'remove-object') {
    snapshot.objects.splice(objectIndex, 1);
    return null;
  }

  const current = snapshot.objects[objectIndex];
  const candidate: PlacedObject = operation.type === 'move-object'
    ? { ...current, x: operation.x, z: operation.z, rotationY: radians(operation.rotationDegrees) }
    : { ...current, rotationY: radians(operation.rotationDegrees) };
  const error = validateCandidate(candidate, snapshot);
  if (error) return `${prefix}: ${error}`;
  snapshot.objects[objectIndex] = candidate;
  return null;
}

export function applyAiProposal(snapshot: PlannerSnapshot, proposal: AiProposal) {
  if (!proposal.operations.length) return { snapshot, error: 'The proposal does not contain any changes.' };
  if (proposal.operations.length > 8) return { snapshot, error: 'The experimental limit is eight operations per proposal.' };
  const next = structuredClone(snapshot) as PlannerSnapshot;
  for (const [index, operation] of proposal.operations.entries()) {
    const error = applyOperation(next, operation, index);
    if (error) return { snapshot, error };
  }
  return { snapshot: next, error: null };
}
