import { useCallback, useRef } from "react";
import { createStagedGiftTracker, type StagedGiftTracker } from "./giftStagedCleanup";
import { cleanupNativeGiftStaging } from "./giftNativeStaging";
import { GiftScreen, GiftScreenError, type GiftPreview } from "./GiftScreen";
import { importNativeGift, pendingGiftImportId, type NativeGiftAsset, type GiftMetadata } from "./giftDeviceImport";
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

export const deviceStagedGifts = createStagedGiftTracker(() => localStorage, cleanupNativeGiftStaging, giftId => pendingGiftImportId(localStorage) === giftId);

export function ExperimentalGiftRoute({ link, transport, onClose, importGift = importNativeGift, staged = deviceStagedGifts }: {
  link: GiftLink;
  transport: GiftTransport;
  onClose: () => void;
  importGift?: typeof importNativeGift;
  staged?: StagedGiftTracker;
}) {
  const details = useRef<GiftDetails | null>(null);
  // The gift whose download is staged but not yet in the library.
  const unfinished = useRef<string | null>(null);
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
    unfinished.current = value.giftId;
    staged.note(value.giftId);
    await transport.receive(link, value, signal);
    if (signal.aborted) throw new GiftScreenError("unavailable");
    await importGift(value.giftId, value.assets, value.metadata);
    unfinished.current = null;
    await staged.finish(value.giftId);
  }, [link, transport, importGift, staged]);
  // Leaving a gift that did not arrive gives up on resuming it.
  const close = useCallback(() => {
    if (unfinished.current) void staged.finish(unfinished.current);
    onClose();
  }, [onClose, staged]);
  return <GiftScreen loadPreview={loadPreview} accept={accept} onClose={close} />;
}
