import { returnToLayout } from './ViewErrorBoundary';
import { useEffect, useRef, useState } from 'react';
import { PlannerScene } from './renderer/PlannerScene';
import type { PlanCameraView } from './core/types';
import { usePlannerStore } from './store';

export function Viewport3D({
  furniture = true,
  interactive = true,
  architectureInteractive = false,
  sunRays = true,
  view,
  resetViewRequest = 0,
  onExportReady
}: {
  furniture?: boolean;
  interactive?: boolean;
  architectureInteractive?: boolean;
  sunRays?: boolean;
  view?: PlanCameraView;
  resetViewRequest?: number;
  onExportReady?: (handler: (() => Promise<void>) | null) => void;
}) {
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<PlannerScene | null>(null);
  const internallyChangedViewRef = useRef<PlanCameraView | null>(null);
  const exportingRef = useRef(false);

  const exportGLB = async () => {
    if (!sceneRef.current || exportingRef.current) return;
    exportingRef.current = true;
    try {
      await sceneRef.current.exportGLB();
    } catch (error) {
      console.error('Failed to export GLB', error);
      window.alert('Could not export the room. See the browser console for details.');
    } finally {
      exportingRef.current = false;
    }
  };

  useEffect(() => {
    onExportReady?.(failure ? null : exportGLB);
    return () => onExportReady?.(null);
  }, [onExportReady, failure]);

  useEffect(() => {
    if (!ref.current) return;
    let scene: PlannerScene | null = null;
    let syncFrame = 0;
    let unsubscribe = () => {};
    let stopped = false;
    const fail = (error: unknown) => {
      if (stopped) return;
      stopped = true;
      console.error('Could not render 3D view', error);
      unsubscribe();
      if (syncFrame) cancelAnimationFrame(syncFrame);
      scene?.dispose();
      sceneRef.current = null;
      onExportReady?.(null);
      setFailure(true);
    };
    try {
      scene = new PlannerScene(ref.current, {
        // The renderer treats snapshots as read-only. Returning live immutable Zustand
        // references here avoids structuredClone() of the entire project on every render
        // frame; history/drag snapshots still clone explicitly at interaction boundaries.
        getSnapshot: () => {
          const state = usePlannerStore.getState();
          return {
            room: state.room,
            openings: state.openings,
            dividers: state.dividers,
            spaces: state.spaces,
            objects: state.objects,
            unplacedObjects: state.unplacedObjects,
            selectedId: state.selectedId,
            selectedSpaceId: state.selectedSpaceId,
            interiorWallView: state.interiorWallView,
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
        selectSpace: (id) => usePlannerStore.getState().selectSpace(id),
        selectOpening: (id) => usePlannerStore.getState().selectOpening(id),
        selectWall: (id) => usePlannerStore.getState().selectWall(id),
        selectDivider: (id) => usePlannerStore.getState().selectDivider(id),
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
      }, {
        showFurniture: furniture,
        interactiveFurniture: interactive,
        interactiveArchitecture: architectureInteractive,
        sunRays,
        onError: fail
      });
      sceneRef.current = scene;
      if (view) scene.setCameraView(view);
      unsubscribe = usePlannerStore.subscribe((state, previous) => {
        const sceneStateChanged = state.room !== previous.room
          || state.spaces !== previous.spaces
          || state.dividers !== previous.dividers
          || state.openings !== previous.openings
          || (furniture && state.objects !== previous.objects)
          || (furniture && state.selectedId !== previous.selectedId)
          || state.selectedSpaceId !== previous.selectedSpaceId
          || state.interiorWallView !== previous.interiorWallView
          || (architectureInteractive && state.selectedOpeningId !== previous.selectedOpeningId)
          || (furniture && state.activeSnap !== previous.activeSnap)
          || state.showClearance !== previous.showClearance
          || state.showRoomDimensions !== previous.showRoomDimensions
          || state.showProductDimensions !== previous.showProductDimensions
          || state.showSpacingDimensions !== previous.showSpacingDimensions
          || state.measurementSystem !== previous.measurementSystem;
        if (stopped || !sceneStateChanged || syncFrame) return;
        syncFrame = requestAnimationFrame(() => {
          syncFrame = 0;
          try { scene?.renderFromState(); } catch (error) { fail(error); }
        });
      });
    } catch (error) { fail(error); }
    return () => {
      stopped = true;
      unsubscribe();
      if (syncFrame) cancelAnimationFrame(syncFrame);
      scene?.dispose();
      sceneRef.current = null;
    };
  }, [furniture, interactive, architectureInteractive, sunRays, attempt]);

  useEffect(() => {
    if (!view) return;
    // When PlannerScene itself changes the active preset to Free cam after manual
    // navigation, update the UI/store without snapping the camera to the default
    // free camera position. Explicit button clicks still call setCameraView normally.
    if (internallyChangedViewRef.current === view) {
      internallyChangedViewRef.current = null;
      return;
    }
    sceneRef.current?.setCameraView(view);
  }, [view]);

  useEffect(() => {
    if (resetViewRequest > 0) {
      if (view) sceneRef.current?.setCameraView(view);
      else sceneRef.current?.resetCamera();
    }
  }, [resetViewRequest]);

  return (
    <div className="viewport-stage">
      <div className="viewport" ref={ref} hidden={failure} />
      {failure && <div className="view-error" role="alert">
        <h2>Could not open 3D</h2>
        <p>Your layout is still available. Try again or continue in 2D.</p>
        <div className="view-error-actions">
          <button type="button" className="primary-button" onClick={() => { setFailure(false); setAttempt((value) => value + 1); }}>Try again</button>
          <button type="button" onClick={returnToLayout}>Return to 2D</button>
        </div>
      </div>}
    </div>
  );
}
