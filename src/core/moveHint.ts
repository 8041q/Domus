export const MOVE_ICON_PATH = 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3';

export function createMoveHint(container: HTMLElement) {
  const hint = container.ownerDocument.createElement('span');
  hint.className = 'movable-hover-overlay';
  hint.setAttribute('aria-hidden', 'true');
  hint.hidden = true;
  hint.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${MOVE_ICON_PATH}"/></svg><span>Move</span>`;
  container.appendChild(hint);
  return hint;
}
