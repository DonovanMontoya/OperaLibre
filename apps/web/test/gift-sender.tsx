import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { GiftShareAction } from "../src/GiftShareDialog";
import { setServerConnection, setStoredToken, setUnauthorizedHandler } from "../src/api";

declare global { interface Window { senderSwitchServer(origin: string, token: string): void; senderUnauthorizedCount: number } }
window.senderUnauthorizedCount = 0;
setUnauthorizedHandler(() => { window.senderUnauthorizedCount++; });
window.senderSwitchServer = (origin, token) => { setServerConnection("operalibre", origin, null); setStoredToken(token); };

createRoot(document.getElementById("root")!).render(<main><h1>Book details fixture</h1><GiftShareAction bookId="server-book" enabled={new URLSearchParams(location.search).get("enabled") === "1"} alignmentReady={new URLSearchParams(location.search).get("alignmentReady") === "1"} /></main>);
