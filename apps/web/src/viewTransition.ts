import { flushSync } from "react-dom";

type ViewTransition = { finished: Promise<unknown> };

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => ViewTransition;
};

const owners = new Map<string, ViewTransition>();

/**
 * Runs a layout change as a view transition, with `root.dataset[key]` set to
 * `value` for the stylesheet while it plays. The change applies immediately
 * where the document has no view transitions; deciding against motion for any
 * other reason is the caller's.
 */
export function runMarkedViewTransition(root: HTMLElement, key: string, value: string, update: () => void): void {
  const document = root.ownerDocument as TransitionDocument;
  if (!document.startViewTransition) {
    update();
    return;
  }
  root.dataset[key] = value;
  // React would otherwise commit after the browser takes the new snapshot, and
  // the layout would jump to its new shape once the animation had finished.
  const transition = document.startViewTransition(() => flushSync(update));
  owners.set(key, transition);
  const cleanUp = () => {
    // A second change started mid-flight owns the attribute now.
    if (owners.get(key) !== transition) return;
    owners.delete(key);
    delete root.dataset[key];
  };
  void transition.finished.then(cleanUp, cleanUp);
}
