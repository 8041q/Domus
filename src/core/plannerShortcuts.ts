type ShortcutActions = {
  mode: 'build' | 'plan';
  rotate: () => void;
  remove: () => void;
  undo: () => void;
  redo: () => void;
};

function isInput(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable ||
    !!element.closest?.('input, textarea, select, [role="textbox"], [role="combobox"]'));
}

export function handlePlannerShortcut(event: KeyboardEvent, actions: ShortcutActions, doc: Document = document) {
  if (event.defaultPrevented || event.isComposing || isInput(doc.activeElement) ||
    event.composedPath().some(isInput) || doc.querySelector('dialog[open]')) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault();
    event.shiftKey ? actions.redo() : actions.undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'y') {
    event.preventDefault(); actions.redo(); return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (key === 'x' || (actions.mode === 'plan' && (key === 'delete' || key === 'backspace'))) {
    event.preventDefault(); actions.remove();
  }
  if (actions.mode === 'plan' && key === 'r') actions.rotate();
}
