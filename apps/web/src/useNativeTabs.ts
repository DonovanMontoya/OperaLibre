import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { useEffect, useRef, useState } from "react";
import type { NativeTab, NativeTabsState } from "./nativeTabs";

interface NativeTabsPlugin {
  configure(state: NativeTabsState): Promise<void>;
  hide(): Promise<void>;
  reveal(): Promise<void>;
  addListener(event: "select", listener: (event: { id: NativeTab }) => void): Promise<PluginListenerHandle>;
}
const NativeTabs = registerPlugin<NativeTabsPlugin>("NativeTabs");
// Serialize updates and unmount cleanup across account changes and StrictMode.
let updates: Promise<unknown> = Promise.resolve();

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// UIKit resizes the web view after it lays out the bar. Wait for that resize
// (or a short fallback), then a frame for the viewport height to sync.
function afterViewportSettles(): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = () => {
      window.removeEventListener("resize", settle);
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(settle, 300);
    window.addEventListener("resize", settle);
  }).then(nextFrame);
}

/**
 * `shown` follows the bar once UIKit has applied it and the web view has its
 * new size, so a full-screen layer can mount or leave at its final size.
 */
export function useNativeTabs(
  state: NativeTabsState,
  onSelect: (tab: NativeTab) => void
): { ready: boolean; shown: boolean } {
  const available = Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("NativeTabs");
  const [ready, setReady] = useState(false);
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  const [listening, setListening] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const callback = useRef(onSelect);
  callback.current = onSelect;
  // Sheets animate inside a stable viewport. Resizing it by removing the
  // native bar mid-animation makes the reader and sheet jump between layouts.
  const serialized = JSON.stringify({ ...state, blocked: modalOpen });

  useEffect(() => {
    if (!available) return;
    let disposed = false;
    const listener = NativeTabs.addListener("select", ({ id }) => {
      if (!disposed) callback.current(id);
    });
    void listener.then(() => { if (!disposed) setListening(true); }).catch(() => {
      if (!disposed) setListening(false);
    });
    return () => {
      disposed = true;
      void listener.then((handle) => handle.remove()).catch(() => {});
      updates = updates.catch(() => {}).then(() => NativeTabs.hide()).catch(() => {});
      document.documentElement.classList.remove("uikit-tabs");
    };
  }, [available]);

  useEffect(() => {
    if (!available) return;
    const update = () => setModalOpen(Boolean(document.querySelector('.modal-scrim, [aria-modal="true"]')));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [available]);

  useEffect(() => {
    if (!available || !listening) return;
    let disposed = false;
    updates = updates.catch(() => {}).then(async () => {
      if (disposed) return;
      try {
        const next = JSON.parse(serialized) as NativeTabsState;
        await NativeTabs.configure(next);
        const toggled = next.visible !== shownRef.current;
        shownRef.current = next.visible;
        if (!disposed) {
          document.documentElement.classList.add("uikit-tabs");
          setReady(true);
        }
        if (toggled) {
          // Native covers the page while the bar comes or goes. Lift the
          // cover only after the resized page has rendered and painted.
          void afterViewportSettles()
            .then(() => {
              if (!disposed) setShown(next.visible);
              return nextFrame().then(nextFrame);
            })
            .then(() => NativeTabs.reveal())
            .catch(() => {});
        } else if (!disposed) {
          setShown(next.visible);
        }
      } catch {
        await NativeTabs.hide().catch(() => {});
        if (!disposed) {
          document.documentElement.classList.remove("uikit-tabs");
          setReady(false);
        }
      }
    });
    return () => { disposed = true; };
  }, [available, listening, serialized]);
  return { ready, shown };
}
