import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BookStoreSettings } from "../src/SettingsCards";
import type { StoreSettingsTarget } from "../src/nativeTabs";
import type { AuthUser } from "../src/types";
import "../src/styles.css";

document.documentElement.classList.add("native-app", "platform-ios");
const params = new URLSearchParams(location.search);
const requested = params.get("target");
const actualFetch = window.fetch;
window.fetch = async (input, init) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
  if (!path.startsWith("/api/me/libro")) return actualFetch(input, init);
  return new Response(JSON.stringify({ connected: false, email: null, accounts: [], syncedAt: null, books: [], jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const owner = { id: "owner", username: "Owner", isAdmin: true, isOwner: true, canApproveLibationRequests: true, allowedBookIds: null, libationAccess: "direct",
  shareProgress: true, announceFinishes: true, notifyFinishes: true } as AuthUser;

// The groups sit below a tall page, as they do under the other Settings cards.
function Fixture() {
  const [target, setTarget] = useState<StoreSettingsTarget | null>(requested === "audible" || requested === "libro" ? requested : null);
  return <main>
    <div style={{ height: 1600 }} />
    <BookStoreSettings
      allAudibleAccounts={[]} applyAdminLibraryChange={() => undefined} audibleManagement={<p style={params.has("tall") ? { height: 1200 } : undefined}>Audible management</p>}
      brokenLibationAccounts={[]} canBrowseLibation currentUser={owner} isOperaLibre libroAccounts={[]} libroAvailable
      libroOnDevice={false} libroRefreshKey={0} localMode={false} nativeTab="settings" setBooks={() => undefined}
      setLibroAccounts={() => undefined} setLibroDestination={() => undefined}
      target={target} onTargetShown={() => setTarget(null)}
    />
    <div style={{ height: 1600 }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
