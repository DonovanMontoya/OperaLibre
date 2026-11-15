import { useEffect, useRef, useState, type ReactNode } from "react";
import { deviceStagedGifts, ExperimentalGiftRoute, type GiftTransport } from "./ExperimentalGiftRoute";
import { parseExperimentalGiftFragment, parseGiftAssociatedOrigins, watchNativeGiftLinks, type NativeGiftApp, type NativeGiftLaunch } from "./giftAppLinks";
import type { GiftReceivingPreference } from "./giftReceiving";
import "./giftScreen.css";

// A Capacitor plugin answers every property, `then` included, so resolving a
// promise with the plugin itself asks native code for a "then" method and
// never settles. Hand back plain functions instead.
const loadNativeApp = async (): Promise<NativeGiftApp> => {
  const { App } = await import("@capacitor/app");
  return { addListener: (event, listener) => App.addListener(event, listener), getLaunchUrl: () => App.getLaunchUrl() };
};
const LAUNCH_WAIT_MS = 2000;
const associatedOrigins = parseGiftAssociatedOrigins(import.meta.env.VITE_GIFT_ASSOCIATED_ORIGINS);

/** A launch boundary, not a login or server-selection hook. With `receiving`,
 * a gift link contacts nothing until this device's owner has turned gifts on. */
export function GiftAppBoundary({ enabled, native, transport, children, loadApp = loadNativeApp, receiving }: {
  enabled: boolean;
  native: boolean;
  transport: GiftTransport;
  children: ReactNode;
  loadApp?: () => Promise<NativeGiftApp>;
  receiving?: GiftReceivingPreference;
}) {
  const [gift, setGift] = useState<NativeGiftLaunch | null>(() => {
    if (!enabled || native || window.location.pathname !== "/gift" || window.location.search) return null;
    const link = parseExperimentalGiftFragment(window.location.hash);
    return link ? { originalUrl: window.location.href, link } : null;
  });
  const [launchPending, setLaunchPending] = useState(enabled && native);
  // Covers a device whose storage cannot remember the choice.
  const [consented, setConsented] = useState<string | null>(null);
  const appMounted = useRef(false);
  useEffect(() => {
    if (!enabled || !native) return;
    let active = true;
    let stop: (() => void) | undefined;
    void deviceStagedGifts.sweep();
    // The app must open even if the native bridge never answers.
    const giveUp = window.setTimeout(() => setLaunchPending(false), LAUNCH_WAIT_MS);
    void loadApp().then(app => {
      if (active) stop = watchNativeGiftLinks(app, launch => setGift(launch), () => setLaunchPending(false), associatedOrigins);
    }).catch(() => { if (active) setLaunchPending(false); });
    return () => { active = false; window.clearTimeout(giveUp); stop?.(); };
  }, [enabled, native, loadApp]);

  let screen: ReactNode = null;
  if (enabled && gift) {
    const close = () => {
      if (!native) window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setGift(null);
    };
    // Read for each link: the Settings switch may have changed since launch.
    screen = !receiving || receiving.enabled() || consented === gift.originalUrl
      ? <ExperimentalGiftRoute key={gift.originalUrl} link={gift.link} transport={transport} onClose={close} />
      : <main className="gift-screen" aria-labelledby="gift-heading"><section className="gift-plain">
        <h1 id="gift-heading">Someone sent you a book</h1>
        <p>Book gifts are experimental and turned off on this device. Opening this one contacts the sender's gift service at {new URL(gift.link.broker).hostname}. Nothing downloads until you accept the book.</p>
        <p>Only open gifts from people you trust.</p>
        <div className="gift-actions">
          <button type="button" className="gift-primary" onClick={() => { receiving.set(true); setConsented(gift.originalUrl); }}>Turn on gifts and open</button>
          <button type="button" className="gift-secondary" onClick={close}>Not now</button>
        </div>
        <p className="gift-fineprint">You can turn this off again in Settings.</p>
      </section></main>;
  } else if (enabled && native && launchPending) {
    return <main><p role="status">Opening OperaLibre…</p></main>;
  }
  // A gift that opens the app is shown before anything else loads. One that
  // arrives later covers the running app, so playback and its state carry on.
  if (screen && !appMounted.current) return screen;
  appMounted.current = true;
  // The layer also covers anything the app rendered outside this tree, such as an open reader.
  return <>{screen ? <div className="gift-layer">{screen}</div> : null}<div style={{ display: screen ? "none" : "contents" }}>{children}</div></>;
}
