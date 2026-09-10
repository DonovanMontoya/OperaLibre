import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { useEffect, useRef, useState } from "react";
import type { NativeTab, NativeTabsState } from "./nativeTabs";

interface NativeTabsPlugin {
  configure(state: NativeTabsState): Promise<void>;
  hide(): Promise<void>;
  addListener(event: "select", listener: (event: { id: NativeTab }) => void): Promise<PluginListenerHandle>;
}
const NativeTabs = registerPlugin<NativeTabsPlugin>("NativeTabs");
// Serialize updates and unmount cleanup across account changes and StrictMode.
let updates: Promise<unknown> = Promise.resolve();

export function useNativeTabs(state: NativeTabsState, onSelect: (tab: NativeTab) => void): boolean {
  const available = Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("NativeTabs");
  const [ready, setReady] = useState(false);
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
        await NativeTabs.configure(JSON.parse(serialized) as NativeTabsState);
        if (!disposed) {
          document.documentElement.classList.add("uikit-tabs");
          setReady(true);
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
  return ready;
}
