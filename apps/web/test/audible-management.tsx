import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AudibleManagement } from "../src/AudibleManagement";
import { getLibationStatus } from "../src/api";
import type { usePurchases } from "../src/usePurchases";
import type { AuthUser, LibationAccount, LibationStatus } from "../src/types";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const account: LibationAccount = {
  id: params.has("legacy") ? "legacy-fixture" : "family", name: params.has("legacy") ? null : "Family", accountId: "family@example.test", locale: "us",
  authenticated: false, managed: !params.has("legacy"), scanLibrary: true, connectionState: "needs_sign_in",
  lastSuccessfulAuth: null, lastSuccessfulRefresh: null,
  lastError: params.has("icu") ? "No region is associated with the Invariant Culture" : "This Audible account needs to be signed in again.",
  addedBy: "owner", addedAt: "1700000000"
};
let status: LibationStatus = {
  enabled: !params.has("missing"), cliPath: "/server/libation/LibationCli", libationFilesDir: null,
  libraryRoot: "/server/audiobooks", accounts: params.has("missing") ? [] : [account],
  authenticated: false, message: null, autoRefreshHours: 24, manualRefreshesPerHour: 3,
  lastSuccessfulRefresh: 1700000000, autoImportAccountIds: [], pendingLogin: params.has("pending") ? {
    sessionId: "pending-session", profileId: "family", loginUrl: "https://www.amazon.com/ap/signin?fixture=true", expiresAt: Math.floor(Date.now() / 1000) + 600
  } : null
};
const calls: { path: string; method: string; body: unknown; }[] = [];
Object.assign(window, { audibleCalls: calls });
const actualFetch = window.fetch;
window.fetch = async (input, init) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
  if (!path.startsWith("/api/libation/")) return actualFetch(input, init);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ path, method, body });
  let result: unknown = status;
  let code = 200;
  if (path.endsWith("/setup")) result = {
    canSignIn: status.enabled && !params.has("busy"), busy: params.has("busy"),
    checks: [{ id: "installed", label: "Libation installed", ready: status.enabled, message: status.enabled ? "Libation is installed." : "Install Libation on the server." }, { id: "storage", label: "Library storage", ready: true, message: "The library has space for imports." }]
  };
  else if (path.endsWith("/login/start")) {
    if (params.has("slow")) await new Promise<void>(resolve => Object.assign(window, { finishAudibleStart: resolve }));
    const id = body.profileId ?? "personal";
    status.pendingLogin = { sessionId: "fixture-session", profileId: id, loginUrl: "https://www.amazon.com/ap/signin?fixture=true", expiresAt: Math.floor(Date.now() / 1000) + 600 };
    result = status.pendingLogin;
  } else if (path.endsWith("/complete")) {
    if (params.has("failure")) { code = 502; result = { message: "Libation login failed: Authentication failed" }; status.pendingLogin = null; }
    else {
      const id = status.pendingLogin?.profileId ?? "personal";
      const existing = status.accounts.find(item => item.id === id);
      const connected = { ...account, ...existing, id, name: existing?.name ?? "Personal", authenticated: true, connectionState: "connected", lastError: null };
      status = { ...status, pendingLogin: null, accounts: [...status.accounts.filter(item => item.id !== id), connected] };
      result = status;
    }
  } else if (path.includes("/login/") && method === "DELETE") { status.pendingLogin = null; code = 204; }
  else if (path.endsWith("/auto-import")) {
    status.autoImportAccountIds = body.enabled ? ["family"] : [];
    result = status;
  }
  return new Response(code === 204 ? null : JSON.stringify(result), { status: code, headers: { "Content-Type": "application/json" } });
};

function Fixture() {
  const [current, setCurrent] = useState(status);
  const currentUser: AuthUser = {
    id: "owner", username: "Owner", isAdmin: !params.has("reader"), isOwner: !params.has("reader"),
    canApproveLibationRequests: true, allowedBookIds: null, libationAccess: params.has("reader") ? "approval" : "direct",
    shareProgress: true, announceFinishes: true, notifyFinishes: true
  };
  const purchases = {
    libationStatus: params.has("reader") ? { ...current, accounts: [] } : current,
    setLibationStatus: setCurrent,
    setLibationBooksLoaded: () => undefined,
    loadLibationStatus: async () => setCurrent(await getLibationStatus()),
    startLibationSync: async () => undefined, startAllLiberation: async () => undefined,
    libationLoading: false, libationAllPending: false, libationRefreshPending: false, isRefreshingAudible: false,
    libationError: null, downloadAllLibationJob: undefined, refreshLibationJob: undefined
  } as ReturnType<typeof usePurchases>;
  return <main className="settings-card purchase-provider-settings" style={{ maxWidth: 700, margin: "24px auto", padding: 24 }}>
    <h1>Audible</h1><AudibleManagement currentUser={currentUser} native={params.has("native")} purchases={purchases} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
