const openModals: HTMLElement[] = [];

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]'
  )).filter(element => element.tabIndex >= 0 && !element.matches(':disabled, [hidden]')
    && !element.closest('[inert]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden');
}

/** Keep keyboard interaction in the topmost dialog and return it to its opener. */
export function containModalFocus(dialog: HTMLElement, onDismiss: () => void) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  openModals.push(dialog);
  const isTopmost = () => openModals[openModals.length - 1] === dialog;
  const focusFirst = () => {
    const elements = focusableElements(dialog);
    (elements.find(element => element.hasAttribute('data-modal-initial-focus')) ?? elements[0] ?? dialog).focus();
  };
  const onFocus = (event: FocusEvent) => {
    if (isTopmost() && !dialog.contains(event.target as Node)) focusFirst();
  };
  const onKey = (event: KeyboardEvent) => {
    if (!isTopmost()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      onDismiss();
    } else if (event.key === 'Tab') {
      const elements = focusableElements(dialog);
      const current = elements.indexOf(document.activeElement as HTMLElement);
      if (!elements.length) {
        event.preventDefault();
        dialog.focus();
      } else if (current < 0 || (event.shiftKey ? current === 0 : current === elements.length - 1)) {
        event.preventDefault();
        elements[event.shiftKey ? elements.length - 1 : 0].focus();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocus);
  if (!dialog.contains(document.activeElement)) focusFirst();
  return () => {
    const wasTopmost = isTopmost();
    openModals.splice(openModals.indexOf(dialog), 1);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocus);
    if (wasTopmost && opener?.isConnected) opener.focus();
  };
}
