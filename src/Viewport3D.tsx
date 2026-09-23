import { useEffect, useRef, useState } from 'react';
import { PlannerScene } from './renderer/PlannerScene';
import type { PlanCameraView } from './core/types';
import { usePlannerStore } from './store';

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
  const internallyChangedViewRef = useRef<PlanCameraView | null>(null);
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
      // The renderer treats snapshots as read-only. Returning live immutable Zustand
      // references here avoids structuredClone() of the entire project on every render
      // frame; history/drag snapshots still clone explicitly at interaction boundaries.
      getSnapshot: () => {
        const state = usePlannerStore.getState();
        return {
          room: state.room,
          openings: state.openings,
          objects: state.objects,
          selectedId: state.selectedId,
          selectedOpeningId: state.selectedOpeningId,
          activeSnap: state.activeSnap,
          showClearance: state.showClearance,
          showRoomDimensions: state.showRoomDimensions,
          showProductDimensions: state.showProductDimensions,
          showSpacingDimensions: state.showSpacingDimensions,
          measurementSystem: state.measurementSystem
        };
      },
      select: (id) => usePlannerStore.getState().select(id),
      selectOpening: (id) => usePlannerStore.getState().selectOpening(id),
      updateObject: (id, patch) => usePlannerStore.getState().updateObject(id, patch),
      updateOpening: (id, patch, recordHistory = true) => usePlannerStore.getState().updateOpening(id, patch, recordHistory),
      commitDrag: (before) => usePlannerStore.getState().commitSnapshot(before),
      feedback: (snap, collisionId, collisionPush) => usePlannerStore.getState().setFeedback(snap, collisionId, collisionPush),
      cameraViewChanged: (nextView) => {
        const state = usePlannerStore.getState();
        if (state.planView !== nextView) {
          internallyChangedViewRef.current = nextView;
          state.setPlanView(nextView);
        }
      }
    }, { showFurniture: furniture, interactiveFurniture: interactive, interactiveArchitecture: architectureInteractive });
    sceneRef.current = scene;
    if (view) scene.setCameraView(view);
    let syncFrame = 0;
    const unsubscribe = usePlannerStore.subscribe((state, previous) => {
      const sceneStateChanged = state.room !== previous.room
        || state.openings !== previous.openings
        || (furniture && state.objects !== previous.objects)
        || (furniture && state.selectedId !== previous.selectedId)
        || (architectureInteractive && state.selectedOpeningId !== previous.selectedOpeningId)
        || (furniture && state.activeSnap !== previous.activeSnap)
        || state.showClearance !== previous.showClearance
        || state.showRoomDimensions !== previous.showRoomDimensions
        || state.showProductDimensions !== previous.showProductDimensions
        || state.showSpacingDimensions !== previous.showSpacingDimensions
        || state.measurementSystem !== previous.measurementSystem;
      if (!sceneStateChanged || syncFrame) return;
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
    if (!view) return;
    // When PlannerScene itself changes the active preset to Dollhouse after manual
    // navigation, update the UI/store without snapping the camera to the default
    // dollhouse position. Explicit button clicks still call setCameraView normally.
    if (internallyChangedViewRef.current === view) {
      internallyChangedViewRef.current = null;
      return;
    }
    sceneRef.current?.setCameraView(view);
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
