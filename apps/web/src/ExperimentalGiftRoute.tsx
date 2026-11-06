import { useCallback, useRef } from "react";
import { GiftScreen, GiftScreenError, type GiftPreview } from "./GiftScreen";
import { importNativeGift, type NativeGiftAsset } from "./giftDeviceImport";
import "./giftScreen.css";

export type GiftLink = { broker: string; token: string; previewKey?: string; signingKey?: string };
export type GiftDetails = { preview: GiftPreview; giftId: string; assets: NativeGiftAsset[]; metadata: { title: string; author?: string | null; description?: string | null } };
export type GiftTransport = {
  /** Retrieve only bounded preview data; do not receive book assets. */
  preview(link: GiftLink, signal: AbortSignal): Promise<GiftDetails>;
  /** Receive an archive into app-private staging after explicit acceptance. */
  receive(link: GiftLink, details: GiftDetails, signal: AbortSignal): Promise<void>;
};

/** Fragment parameters are never sent in the initial page request. Domain
 * association and native app-link delivery are separate platform work. */
export function parseExperimentalGiftFragment(fragment: string): GiftLink | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  if ([...params.keys()].some(key => !["gift", "broker", "key", "signing"].includes(key)) || params.getAll("gift").length !== 1 || params.getAll("broker").length !== 1 || params.getAll("key").length > 1 || params.getAll("signing").length > 1) return null;
  const token = params.get("gift") ?? "";
  if (!/^[A-Za-z0-9_-]{32,4096}$/.test(token)) return null;
  const previewKey = params.get("key"), signingKey = params.get("signing");
  if (!!previewKey !== !!signingKey || (previewKey && !/^[A-Za-z0-9_-]{43}$/.test(previewKey)) || (signingKey && !/^[A-Za-z0-9_-]{43}$/.test(signingKey))) return null;
  try {
    const broker = new URL(params.get("broker") ?? "");
    if (broker.protocol !== "https:" || broker.username || broker.password || broker.pathname !== "/" || broker.search || broker.hash) return null;
    return { broker: broker.origin, token, ...(previewKey && signingKey ? { previewKey, signingKey } : {}) };
  } catch { return null; }
}

/** Construct a link only for an HTTPS landing origin that the owner controls.
 * App association and the landing page must be configured separately. */
export function createExperimentalGiftLink(landing: string, link: GiftLink): string {
  const url = new URL(landing);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !link.previewKey || !link.signingKey) throw new Error("Invalid gift link configuration");
  const params = new URLSearchParams({ gift: link.token, broker: link.broker, key: link.previewKey, signing: link.signingKey });
  if (!parseExperimentalGiftFragment(params.toString())) throw new Error("Invalid gift link credentials");
  url.pathname = "/gift";
  url.hash = params.toString();
  return url.toString();
}

/** There is no approved live transport yet. This must fail closed. */
export const unavailableGiftTransport: GiftTransport = {
  async preview() { throw new GiftScreenError("unavailable"); },
  async receive() { throw new GiftScreenError("unavailable"); }
};

export function ExperimentalGiftRoute({ link, transport, onClose, importGift = importNativeGift }: {
  link: GiftLink;
  transport: GiftTransport;
  onClose: () => void;
  importGift?: typeof importNativeGift;
}) {
  const details = useRef<GiftDetails | null>(null);
  const loadPreview = useCallback(async (signal: AbortSignal) => {
    details.current = null;
    const value = await transport.preview(link, signal);
    if (signal.aborted) throw new GiftScreenError("unavailable");
    details.current = value;
    return value.preview;
  }, [link, transport]);
  const accept = useCallback(async (signal: AbortSignal) => {
    const value = details.current;
    if (!value) throw new GiftScreenError("unavailable");
    await transport.receive(link, value, signal);
    if (signal.aborted) throw new GiftScreenError("unavailable");
    await importGift(value.giftId, value.assets, value.metadata);
  }, [link, transport, importGift]);
  return <GiftScreen loadPreview={loadPreview} accept={accept} onClose={onClose} />;
}
