export type GiftAssetKind = "metadata" | "ebook" | "cover" | "audio" | "alignment";
export type GiftInventoryAsset = { id: string; kind: GiftAssetKind; fileName: string; sizeBytes: number; available: boolean; disabledReason?: string | null; requiresAssetIds?: string[] };
export type GiftInventory = { bookId: string; title: string; assets: GiftInventoryAsset[]; defaultSelectedAssetIds: string[]; maxBytes: number };
export type SelectedGiftRequest = { bookId: string; selectedAssetIds: string[]; personalMessage?: string; expiresInSeconds?: number };
export type CreatedGift = { giftUrl: string; expiresAt: number; managementToken?: string };
export type SenderCreatedGift = CreatedGift & { revoke?: (signal?: AbortSignal) => Promise<void> };

const plain = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const kinds = new Set(["metadata", "ebook", "cover", "audio", "alignment"]);

/** Only a server inventory is accepted; Book paths, client hashes and guessed
 * availability are deliberately not part of this contract. */
export function parseGiftInventory(value: unknown, expectedBookId: string): GiftInventory {
  const invalid = () => new Error("The server returned an invalid gift inventory.");
  if (!value || typeof value !== "object") throw invalid();
  const v = value as GiftInventory;
  if (v.bookId !== expectedBookId || !plain(v.bookId, 256) || !plain(v.title, 2000) || !Array.isArray(v.assets) || v.assets.length < 1 || v.assets.length > 256 || !Number.isSafeInteger(v.maxBytes) || v.maxBytes <= 0 || !Array.isArray(v.defaultSelectedAssetIds)) throw invalid();
  const ids = new Set<string>();
  for (const asset of v.assets) {
    if (!asset || !plain(asset.id, 256) || ids.has(asset.id) || !kinds.has(asset.kind) || !plain(asset.fileName, 512) || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0 || typeof asset.available !== "boolean" || (asset.disabledReason != null && !plain(asset.disabledReason, 2000)) || (asset.requiresAssetIds !== undefined && (!Array.isArray(asset.requiresAssetIds) || asset.requiresAssetIds.length > 256 || asset.requiresAssetIds.some(id => !plain(id, 256)) || new Set(asset.requiresAssetIds).size !== asset.requiresAssetIds.length))) throw invalid();
    ids.add(asset.id);
  }
  if (!v.assets.some(asset => asset.kind === "metadata") || v.defaultSelectedAssetIds.length > 256 || v.defaultSelectedAssetIds.some(id => !ids.has(id)) || new Set(v.defaultSelectedAssetIds).size !== v.defaultSelectedAssetIds.length || v.assets.some(asset => asset.requiresAssetIds?.some(id => !ids.has(id) || id === asset.id))) throw invalid();
  return structuredClone(v);
}

export type GiftSelectionCapabilities = { alignmentReady?: boolean };

export function giftAssetDisabledReason(asset: GiftInventoryAsset, alignmentReady = false): string | null {
  if (asset.kind === "alignment" && !alignmentReady) return "Read-along alignment is not supported in this build yet. It needs matching text and audio, including the complete audio set, plus verified native/local map loading.";
  return asset.disabledReason ?? (asset.available ? null : "This asset is not available for sharing.");
}

/** An explicit map opt-in expands only server-declared matching dependencies.
 * It never infers an EPUB edition or audio identity from client Book metadata.
 * Readiness must be explicitly supplied by an integrated/reviewed build; it
 * cannot override an unavailable server asset or incomplete dependency set. */
export function alignmentGiftSelection(inventory: GiftInventory, alignmentId: string, current = defaultGiftSelection(inventory), capabilities: GiftSelectionCapabilities = {}) {
  const map = inventory.assets.find(asset => asset.id === alignmentId && asset.kind === "alignment");
  if (!map) throw new Error("The server did not provide this alignment asset.");
  const dependencies = new Set(map.requiresAssetIds ?? []);
  const audio = inventory.assets.filter(asset => asset.kind === "audio");
  const text = inventory.assets.filter(asset => asset.kind === "ebook" && dependencies.has(asset.id));
  if (!audio.length || audio.some(asset => !dependencies.has(asset.id)) || text.length !== 1 || !text[0].fileName.toLowerCase().endsWith(".epub")) throw new Error("The map must bind the matching EPUB and complete audio set; subset maps are not supported.");
  const selected = new Set(inventory.assets.filter(asset => asset.kind === "metadata" || (asset.kind === "cover" && current.includes(asset.id))).map(asset => asset.id));
  for (const id of dependencies) {
    const asset = inventory.assets.find(item => item.id === id);
    if (!asset || (asset.kind !== "metadata" && asset.kind !== "audio" && asset.id !== text[0].id)) throw new Error("The server returned an unsupported alignment dependency.");
    const reason = giftAssetDisabledReason(asset, capabilities.alignmentReady === true);
    if (reason) throw new Error(`${asset.fileName}: ${reason}`);
    selected.add(id);
  }
  selected.add(map.id);
  return { selectedAssetIds: inventory.assets.filter(asset => selected.has(asset.id)).map(asset => asset.id), disabledReason: giftAssetDisabledReason(map, capabilities.alignmentReady === true) };
}

export function defaultGiftSelection(inventory: GiftInventory): string[] {
  const selected = new Set(inventory.defaultSelectedAssetIds.filter(id => {
    const asset = inventory.assets.find(item => item.id === id)!;
    return !giftAssetDisabledReason(asset);
  }));
  for (const asset of inventory.assets) if (asset.kind === "metadata" || (asset.kind === "audio" && !giftAssetDisabledReason(asset))) selected.add(asset.id);
  for (const kind of ["ebook", "cover"]) {
    if (![...selected].some(id => inventory.assets.find(asset => asset.id === id)?.kind === kind)) {
      const asset = inventory.assets.find(asset => asset.kind === kind && !giftAssetDisabledReason(asset));
      if (asset) selected.add(asset.id);
    }
  }
  return inventory.assets.filter(asset => selected.has(asset.id)).map(asset => asset.id);
}

export function giftSelectionSummary(inventory: GiftInventory, selectedIds: string[], capabilities: GiftSelectionCapabilities = {}) {
  const selected = new Set(selectedIds);
  const assets = inventory.assets.filter(asset => selected.has(asset.id));
  const errors: string[] = [];
  if (selected.size !== selectedIds.length || assets.length !== selected.size) errors.push("Selection contains duplicate or unknown assets. Reload the inventory.");
  for (const asset of inventory.assets) {
    if (asset.kind === "metadata" && !selected.has(asset.id)) errors.push("Metadata must be included.");
    if (!selected.has(asset.id)) continue;
    const reason = giftAssetDisabledReason(asset, capabilities.alignmentReady === true);
    if (reason) errors.push(`${asset.fileName}: ${reason}`);
    for (const id of asset.requiresAssetIds ?? []) if (!selected.has(id)) errors.push(`${asset.fileName} requires ${inventory.assets.find(item => item.id === id)?.fileName ?? "a matching asset"}.`);
    if (asset.kind === "alignment") {
      try {
        const plan = alignmentGiftSelection(inventory, asset.id, selectedIds, capabilities);
        if (plan.selectedAssetIds.some(id => !selected.has(id))) errors.push("Alignment requires the matching EPUB and complete audio set; subset maps are not supported.");
        if (assets.filter(item => item.kind === "ebook").length !== 1 || assets.filter(item => item.kind === "alignment").length !== 1) errors.push("Choose exactly the matching EPUB and one alignment map.");
      } catch (failure) { errors.push(failure instanceof Error ? failure.message : "Alignment dependencies are unavailable."); }
    }
  }
  if (!assets.some(asset => asset.kind === "ebook" || asset.kind === "audio")) errors.push("Choose an available ebook or audio file.");
  const sizeBytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes > inventory.maxBytes) errors.push("The selected assets exceed the server's gift size limit.");
  const formats = [...new Set(assets.map(asset => asset.kind === "metadata" ? "Metadata" : asset.kind === "cover" ? "Cover" : asset.kind === "alignment" ? "Read-along" : asset.fileName.split(".").pop()?.toUpperCase() || asset.kind))];
  return { assets, sizeBytes, formats, errors: [...new Set(errors)] };
}

export function selectedGiftRequest(inventory: GiftInventory, selectedIds: string[], message: string, expiresInSeconds = 900, capabilities: GiftSelectionCapabilities = {}): SelectedGiftRequest {
  const summary = giftSelectionSummary(inventory, selectedIds, capabilities);
  if (summary.errors.length) throw new Error(summary.errors[0]);
  if (Array.from(message).length > 1000) throw new Error("The personal message must be at most 1000 characters.");
  if (message.includes("\0")) throw new Error("The personal message contains an unsupported character.");
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) throw new Error("Choose an expiry between one and fifteen minutes.");
  return { bookId: inventory.bookId, selectedAssetIds: summary.assets.map(asset => asset.id), ...(message.trim() ? { personalMessage: message } : {}), expiresInSeconds };
}

export function parseCreatedGift(value: unknown): CreatedGift {
  if (!value || typeof value !== "object") throw new Error("No usable gift link was returned.");
  const gift = value as CreatedGift;
  if (typeof gift.giftUrl !== "string" || gift.giftUrl.length > 16384 || /[\u0000-\u0020\u007f]/.test(gift.giftUrl) || !Number.isSafeInteger(gift.expiresAt) || gift.expiresAt <= 0 || gift.expiresAt > 8_640_000_000_000) throw new Error("No usable gift link was returned.");
  const url = new URL(gift.giftUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/gift" || url.search || !url.hash || url.hash.length > 8193) throw new Error("No usable gift link was returned.");
  if (gift.managementToken !== undefined && (typeof gift.managementToken !== "string" || gift.managementToken.length < 32 || gift.managementToken.length > 4096 || /[^A-Za-z0-9_-]/.test(gift.managementToken))) throw new Error("No usable gift management context was returned.");
  if (gift.managementToken && gift.giftUrl.includes(gift.managementToken)) throw new Error("A private management token cannot be shared in the gift URL.");
  return { giftUrl: gift.giftUrl, expiresAt: gift.expiresAt, ...(gift.managementToken !== undefined ? { managementToken: gift.managementToken } : {}) };
}

export function giftSizeLabel(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "Size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  const power = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(1)} ${["B", "KiB", "MiB", "GiB"][power]}`;
}
