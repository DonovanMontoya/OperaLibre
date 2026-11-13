import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { GiftShareAction, GiftShareDialog, useBookGiftSending } from "../src/GiftShareDialog";
import { setServerConnection, setStoredToken, setUnauthorizedHandler, setBookGiftsEnabled, installGiftBrokerOnCloudflare, deleteGiftOwnerConfiguration } from "../src/api";

declare global { interface Window { senderSwitchServer(origin: string, token: string): void; senderUnauthorizedCount: number } }
window.senderUnauthorizedCount = 0;
setUnauthorizedHandler(() => { window.senderUnauthorizedCount++; });
window.senderSwitchServer = (origin, token) => { setServerConnection("operalibre", origin, null); setStoredToken(token); };

function Fixture() {
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams(location.search);
  const sending = useBookGiftSending(params.has("reactive"));
  return <main><h1>Book details fixture</h1><GiftShareAction enabled={params.has("reactive") ? sending : params.get("enabled") === "1"} onOpen={() => setOpen(true)} />
    {open ? <GiftShareDialog bookId="server-book" alignmentReady={params.get("alignmentReady") === "1"} onClose={() => setOpen(false)} /> : null}
    {params.has("reactive") ? <>
      <button onClick={() => void setBookGiftsEnabled(true)}>Enable gifts</button>
      <button onClick={() => void setBookGiftsEnabled(false)}>Disable gifts</button>
      <button onClick={() => void installGiftBrokerOnCloudflare({ apiToken: "cloudflare-test-token-0123456789abcdef" })}>Install broker</button>
      <button onClick={() => void deleteGiftOwnerConfiguration()}>Remove setup</button>
    </> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
