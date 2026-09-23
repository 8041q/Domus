import { useEffect, useRef, useState } from 'react';
import { PlannerScene } from './renderer/PlannerScene';
import type { PlanCameraView } from './core/types';
import { getSnapshot, usePlannerStore } from './store';

export function Viewport3D({
  furniture = true,
  interactive = true,
  architectureInteractive = false,
  view,
  exportable = false
}: {
  furniture?: boolean;
  interactive?: boolean;
  architectureInteractive?: boolean;
  view?: PlanCameraView;
  exportable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<PlannerScene | null>(null);
  const [exporting, setExporting] = useState(false);

  const exportGLB = async () => {
    if (!sceneRef.current || exporting) return;
    setExporting(true);
    try {
      await sceneRef.current.exportGLB();
    } catch (error) {
      console.error('Failed to export GLB', error);
      window.alert('Could not export the room. See the browser console for details.');
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    if (!ref.current) return;
    const scene = new PlannerScene(ref.current, {
      getSnapshot: () => ({
        ...getSnapshot(),
        selectedId: usePlannerStore.getState().selectedId,
        selectedOpeningId: usePlannerStore.getState().selectedOpeningId,
        activeSnap: usePlannerStore.getState().activeSnap,
        showClearance: usePlannerStore.getState().showClearance,
        showRoomDimensions: usePlannerStore.getState().showRoomDimensions,
        showProductDimensions: usePlannerStore.getState().showProductDimensions,
        showSpacingDimensions: usePlannerStore.getState().showSpacingDimensions,
        measurementSystem: usePlannerStore.getState().measurementSystem
      }),
      select: (id) => usePlannerStore.getState().select(id),
      selectOpening: (id) => usePlannerStore.getState().selectOpening(id),
      updateObject: (id, patch) => usePlannerStore.getState().updateObject(id, patch),
      updateOpening: (id, patch, recordHistory = true) => usePlannerStore.getState().updateOpening(id, patch, recordHistory),
      commitDrag: (before) => usePlannerStore.getState().commitSnapshot(before),
      feedback: (snap, collisionId, collisionPush) => usePlannerStore.getState().setFeedback(snap, collisionId, collisionPush)
    }, { showFurniture: furniture, interactiveFurniture: interactive, interactiveArchitecture: architectureInteractive });
    sceneRef.current = scene;
    if (view) scene.setCameraView(view);
    let syncFrame = 0;
    const unsubscribe = usePlannerStore.subscribe(() => {
      if (syncFrame) return;
      syncFrame = requestAnimationFrame(() => {
        syncFrame = 0;
        scene.renderFromState();
      });
    });
    return () => {
      unsubscribe();
      if (syncFrame) cancelAnimationFrame(syncFrame);
      scene.dispose();
      sceneRef.current = null;
    };
  }, [furniture, interactive, architectureInteractive]);

  useEffect(() => {
    if (view) sceneRef.current?.setCameraView(view);
  }, [view]);

  return (
    <div className="viewport-stage">
      <div className="viewport" ref={ref} />
      <div className="floating-view-actions">
        {exportable && (
          <button className="floating-view-button" type="button" onClick={exportGLB} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export GLB'}
          </button>
        )}
        <button className="floating-view-button" type="button" onClick={() => view ? sceneRef.current?.setCameraView(view) : sceneRef.current?.resetCamera()} aria-label="Reset 3D view">
          Reset view
        </button>
      </div>
    </div>
  );
}
