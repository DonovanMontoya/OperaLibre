import { createRoot } from "react-dom/client";
import { GiftScreen, GiftScreenError, type GiftPreview } from "../src/GiftScreen";
import "../src/styles.css";
import "../src/giftScreen.css";

declare global { interface Window { giftAcceptCount: number } }
window.giftAcceptCount = 0;
const preview: GiftPreview = { sender: "Alex", title: "The Little Book", author: "A. Writer", summary: "A small adventure.", message: "I thought you would love this.", coverUrl: null, formats: ["EPUB", "Audiobook"], sizeBytes: 2048 };
const loadPreview = async () => {
  const query = new URLSearchParams(location.search);
  if (query.has("offline")) throw new GiftScreenError("offline");
  if (query.get("failure") === "expired") throw new GiftScreenError("expired");
  if (query.get("failure") === "revoked") throw new GiftScreenError("revoked");
  return preview;
};
const accept = async () => { window.giftAcceptCount++; };
createRoot(document.getElementById("root")!).render(<GiftScreen loadPreview={loadPreview} accept={accept} onClose={() => {}} />);
