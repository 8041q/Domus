import { PlannerScene } from './PlannerScene';
import type { RoomDocumentV2 } from '../core/projectDocument';

/** Export from the 2D builder without replacing its canvas, selection or camera. */
export async function exportRoomDocument(document: RoomDocumentV2) {
  const container = window.document.createElement('div');
  container.setAttribute('aria-hidden', 'true'); container.inert = true;
  container.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;pointer-events:none';
  window.document.body.appendChild(container);
  let scene: PlannerScene | undefined;
  try {
    scene = new PlannerScene(container, {
      getSnapshot: () => document.snapshot,
      select() {}, selectOpening() {}, updateObject() {}, updateOpening() {}, commitDrag() {}, feedback() {},
    }, { showFurniture: false, interactiveFurniture: false, interactiveArchitecture: false, sunRays: false });
    await scene.exportGLB(undefined, document);
  } finally { scene?.dispose(); container.remove(); }
}
