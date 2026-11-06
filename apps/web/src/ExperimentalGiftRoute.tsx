import { useCallback, useRef } from "react";
import { GiftScreen, GiftScreenError, type GiftPreview } from "./GiftScreen";
import { importNativeGift, type NativeGiftAsset, type GiftMetadata } from "./giftDeviceImport";
import "./giftScreen.css";
import type { GiftLink } from "./giftAppLinks";
export { createExperimentalGiftLink, parseExperimentalGiftFragment, type GiftLink } from "./giftAppLinks";

export type GiftDetails = { preview: GiftPreview; giftId: string; assets: NativeGiftAsset[]; metadata: GiftMetadata };
export type GiftTransport = {
  /** Retrieve only bounded preview data; do not receive book assets. */
  preview(link: GiftLink, signal: AbortSignal): Promise<GiftDetails>;
  /** Receive an archive into app-private staging after explicit acceptance. */
  receive(link: GiftLink, details: GiftDetails, signal: AbortSignal): Promise<void>;
};

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
