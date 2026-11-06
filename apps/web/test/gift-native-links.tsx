import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { GiftAppBoundary } from "../src/GiftAppBoundary";
import type { NativeGiftApp } from "../src/giftAppLinks";
import type { GiftTransport } from "../src/ExperimentalGiftRoute";
import "../src/styles.css";

const metrics = { registrations: 0, launches: 0, previews: 0, receives: 0, fallbackMounts: 0, lastGiftId: null as string | null };
let listener: ((event: { url: string }) => void) | undefined;
let resolveLaunch!: (value: { url: string } | undefined) => void;
const launch = new Promise<{ url: string } | undefined>(resolve => { resolveLaunch = resolve; });
const app: NativeGiftApp = {
  async addListener(_event, receive) { metrics.registrations++; listener = receive; return { async remove() { listener = undefined; } }; },
  async getLaunchUrl() { metrics.launches++; return launch; },
};
const loadApp = async () => app;
const transport: GiftTransport = {
  async preview(link) {
    metrics.previews++;
    metrics.lastGiftId = link.giftId ?? null;
    return { giftId: "gift____________", assets: [], metadata: { title: "A private gift" }, preview: { sender: "Alex", title: "A private gift", author: "A. Writer", summary: "A private summary", message: "For you", coverUrl: null, formats: ["EPUB"], sizeBytes: 12 } };
  },
  async receive() { metrics.receives++; },
};
declare global { interface Window { nativeGiftTest: { metrics: typeof metrics; finish(url?: string): void; open(url: string): void } } }
window.nativeGiftTest = { metrics, finish(url) { resolveLaunch(url ? { url } : undefined); }, open(url) { listener?.({ url }); } };
function Fallback() { useEffect(() => { metrics.fallbackMounts++; }, []); return <h1>Server onboarding fallback</h1>; }
createRoot(document.getElementById("root")!).render(<GiftAppBoundary enabled={new URLSearchParams(location.search).get("enabled") === "1"} native transport={transport} loadApp={loadApp}><Fallback /></GiftAppBoundary>);
