import { createRoot } from "react-dom/client";
import { ExperimentalGiftRoute, parseExperimentalGiftFragment, type GiftDetails, type GiftTransport } from "../src/ExperimentalGiftRoute";
import { stageGiftImport } from "../src/giftDeviceImport";

declare global { interface Window { giftReceiveCount: number; giftPreviewCount: number } }
window.giftReceiveCount = 0; window.giftPreviewCount = 0;
localStorage.removeItem("operalibre.deviceLibrary.v1");
localStorage.removeItem("operalibre.giftExtractionJournal.v1");
const link = parseExperimentalGiftFragment(location.hash);
const details: GiftDetails = {
  preview: { sender: "Alex", title: "The Little Book", author: "A. Writer", summary: "An adventure.", message: "For you.", coverUrl: null, formats: ["EPUB"], sizeBytes: 12 },
  giftId: "gift____________", assets: [{ name: "book.epub", size: 12, sha256: "a".repeat(64), kind: "ebook" }], metadata: { title: "The Little Book", author: "A. Writer" }
};
const transport: GiftTransport = {
  async preview() { window.giftPreviewCount++; return details; },
  async receive() { window.giftReceiveCount++; }
};
const importGift = async (giftId: string, assets: GiftDetails["assets"], metadata: GiftDetails["metadata"]) => stageGiftImport(localStorage, giftId, assets, metadata, async () => ({ directory: `device-library/gift-${giftId}` }));
if (link) createRoot(document.getElementById("root")!).render(<ExperimentalGiftRoute link={link} transport={transport} importGift={importGift} onClose={() => {}} />);
else document.getElementById("root")!.textContent = "Invalid gift link";
