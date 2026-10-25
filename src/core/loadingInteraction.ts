/** Only workspace navigation remains interactive during a loading flow. */
export function blocksLoadingInteraction(event: Event) {
  const path = event.composedPath();
  const navigation = path.some(node => (node as Element).matches?.('.mode-stepper button'));
  if (event.type === 'keydown') {
    const key = (event as KeyboardEvent).key;
    return !(key === 'Tab' || (navigation && (key === 'Enter' || key === ' ')));
  }
  // Export downloads are internal work, not an attempt to edit the interface.
  if (event.type === 'click' && path.some(node => (node as Element).matches?.('a[download]'))) return false;
  return !navigation;
}

const locks = new WeakMap<HTMLElement, { count: number; release: () => void }>();
/** Project persistence and scene loading may overlap; release only the last lease. */
export function lockLoadingInteraction(root: HTMLElement) {
  let lock = locks.get(root);
  if (lock) lock.count++;
  else { lock = { count: 1, release: createLoadingInteractionLock(root) }; locks.set(root, lock); }
  let released = false;
  return () => {
    if (released) return; released = true;
    if (--lock.count === 0) { lock.release(); locks.delete(root); }
  };
}

function createLoadingInteractionLock(root: HTMLElement) {
  const previous = new Map<HTMLElement, boolean>();
  const focused = root.ownerDocument.activeElement as HTMLElement | null;
  const restore = () => { for (const [node, inert] of previous) node.inert = inert; previous.clear(); };
  const apply = () => {
    restore();
    const allowed = [...root.querySelectorAll<HTMLElement>('.mode-stepper, .loading-status')];
    const visit = (parent: HTMLElement) => {
      for (const child of parent.children) {
        const node = child as HTMLElement;
        if (allowed.includes(node)) continue;
        if (allowed.some(item => node.contains(item))) visit(node);
        else { previous.set(node, node.inert); node.inert = true; }
      }
    };
    visit(root);
  };
  const stop = (event: Event) => {
    if (!blocksLoadingInteraction(event)) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const events = ['pointerdown', 'pointermove', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'keydown'];
  for (const event of events) window.addEventListener(event, stop, { capture: true, passive: false });
  root.dataset.loadingLocked = 'true';
  apply();
  // Handles views mounting and the centered card moving to the scene surface.
  const observer = new MutationObserver(apply);
  observer.observe(root, { childList: true, subtree: true });
  root.querySelector<HTMLElement>('.mode-stepper button[aria-current="step"]')?.focus({ preventScroll: true });
  return () => {
    observer.disconnect();
    for (const event of events) window.removeEventListener(event, stop, true);
    delete root.dataset.loadingLocked;
    restore();
    if (focused?.isConnected && !focused.closest('[inert]')) focused.focus({ preventScroll: true });
  };
}
