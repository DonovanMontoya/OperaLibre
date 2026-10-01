import { useLayoutEffect, useRef } from "react";
import { containModalFocus } from "./modalFocus";

export function useModalFocus<T extends HTMLElement>(onDismiss: () => void) {
  const dialogRef = useRef<T>(null);
  const dismissRef = useRef(onDismiss);
  useLayoutEffect(() => { dismissRef.current = onDismiss; });
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) return containModalFocus(dialog, () => dismissRef.current());
  }, []);
  return dialogRef;
}
