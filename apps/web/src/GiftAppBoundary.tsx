import { useEffect, useState, type ReactNode } from "react";
import { ExperimentalGiftRoute, type GiftTransport } from "./ExperimentalGiftRoute";
import { parseExperimentalGiftFragment, watchNativeGiftLinks, type NativeGiftApp, type NativeGiftLaunch } from "./giftAppLinks";

const loadNativeApp = async (): Promise<NativeGiftApp> => (await import("@capacitor/app")).App;

/** A launch boundary, not a login or server-selection hook. The production
 * caller keeps enabled=false until transport and native imports are verified. */
export function GiftAppBoundary({ enabled, native, transport, children, loadApp = loadNativeApp }: {
  enabled: boolean;
  native: boolean;
  transport: GiftTransport;
  children: ReactNode;
  loadApp?: () => Promise<NativeGiftApp>;
}) {
  const [gift, setGift] = useState<NativeGiftLaunch | null>(() => {
    if (!enabled || native || window.location.pathname !== "/gift" || window.location.search) return null;
    const link = parseExperimentalGiftFragment(window.location.hash);
    return link ? { originalUrl: window.location.href, link } : null;
  });
  const [launchPending, setLaunchPending] = useState(enabled && native);
  useEffect(() => {
    if (!enabled || !native) return;
    let active = true;
    let stop: (() => void) | undefined;
    void loadApp().then(app => {
      if (active) stop = watchNativeGiftLinks(app, launch => setGift(launch), () => setLaunchPending(false));
    }).catch(() => { if (active) setLaunchPending(false); });
    return () => { active = false; stop?.(); };
  }, [enabled, native, loadApp]);
  if (enabled && gift) return <ExperimentalGiftRoute key={gift.originalUrl} link={gift.link} transport={transport} onClose={() => {
    if (!native) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setGift(null);
  }} />;
  if (enabled && native && launchPending) return <main><p role="status">Opening OperaLibre…</p></main>;
  return children;
}
