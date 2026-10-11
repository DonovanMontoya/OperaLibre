import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AudibleManagement } from "../src/AudibleManagement";
import { usePurchases } from "../src/usePurchases";
import { serverCapabilities } from "../src/serverCapabilities";
import type { AuthUser, JobStatus, LibationAccount, LibationBook, LibationStatus } from "../src/types";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const native = params.has("native");
if (native) document.documentElement.classList.add("native-app", "platform-ios");
if (params.has("dark")) document.documentElement.classList.add("dark-mode");
const account: LibationAccount = {
  id: params.has("legacy") ? "legacy-fixture" : "family", name: params.has("legacy") ? null : "Family", accountId: "family@example.test", locale: "us",
  authenticated: false, managed: !params.has("legacy"), scanLibrary: true, connectionState: "needs_sign_in",
  lastSuccessfulAuth: null, lastSuccessfulRefresh: null,
  lastError: params.has("icu") ? "No region is associated with the Invariant Culture" : "This Audible account needs to be signed in again.",
  addedBy: "owner", addedAt: "1700000000"
};
if (params.has("connected")) Object.assign(account, { authenticated: true, connectionState: "connected", lastError: null });
let status: LibationStatus = {
  enabled: !params.has("missing"), cliPath: "/server/libation/LibationCli", libationFilesDir: null,
  libraryRoot: "/server/audiobooks", accounts: params.has("missing") || params.has("empty") ? [] : [account],
  authenticated: false, message: null, autoRefreshHours: 24, manualRefreshesPerHour: 3,
  lastSuccessfulRefresh: 1700000000, autoImportAccountIds: [], pendingLogin: params.has("pending") ? {
    sessionId: "pending-session", profileId: "family", loginUrl: "https://www.amazon.com/ap/signin?fixture=true", expiresAt: Math.floor(Date.now() / 1000) + 600
  } : null
};
const calls: { path: string; method: string; body: unknown; }[] = [];
const failures = new Set<string>();
let holdCatalog = false;
let holdJobs = false;
let holdStatus = false;
let jobs: JobStatus[] = [];
Object.assign(window, {
  audibleCalls: calls,
  setAudibleFailure: (kind: string, enabled: boolean) => enabled ? failures.add(kind) : failures.delete(kind),
  holdAudibleCatalog: () => { holdCatalog = true; },
  holdAudibleJobs: () => { holdJobs = true; },
  holdAudibleStatus: () => { holdStatus = true; }
});
function catalog(): LibationBook[] {
  return status.accounts.map(item => ({
    catalogId: `${item.id}:fixture`, profileId: item.id, profileName: item.name || item.accountId, accountId: item.accountId,
    asin: "fixture", title: "Family Purchase", subtitle: null, authors: "Fixture Author", narrators: null, lengthMinutes: 60,
    description: null, publisher: null, bookStatus: null, pdfStatus: null, contentType: "Product", locale: item.locale,
    lastDownloaded: null, isAudiblePlus: false, coverArtUrl: null, localBookId: null
  }));
}
const loadBooks = async () => undefined;
const actualFetch = window.fetch;
window.fetch = async (input, init) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
  if (path === "/api/libation/requests") return actualFetch(input, init);
  if (path === "/api/jobs") {
    calls.push({ path, method: "GET", body: null });
    const snapshot = JSON.stringify(jobs);
    if (holdJobs) {
      holdJobs = false;
      await new Promise<void>(resolve => Object.assign(window, { releaseAudibleJobs: resolve }));
    }
    return new Response(snapshot, { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (!path.startsWith("/api/libation/")) return actualFetch(input, init);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ path, method, body });
  let result: unknown = status;
  let code = 200;
  if (path.endsWith("/books")) {
    result = catalog();
    if (holdCatalog) {
      holdCatalog = false;
      await new Promise<void>(resolve => Object.assign(window, { releaseAudibleCatalog: resolve }));
    }
  }
  else if (path.endsWith("/setup")) result = {
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
  } else if (path === "/api/libation/accounts/family" && method === "PUT") {
    status = { ...status, accounts: status.accounts.map(item => item.id === "family" ? { ...item, name: body.label } : item) };
    result = status;
  } else if (path === "/api/libation/accounts/family" && method === "DELETE") {
    status = { ...status, accounts: status.accounts.filter(item => item.id !== "family") };
    code = 204;
  } else if (path === "/api/libation/sync") {
    jobs = [{ id: "fixture-refresh", kind: "libation-sync", status: "queued", targetId: null, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, output: "Checking purchases.", error: null }];
    result = { jobId: "fixture-refresh" };
  }
  const failure = path.endsWith("/status") ? "status" : path.endsWith("/books") ? "catalog" : path.endsWith("/liberate-all") ? "import" : null;
  if (failure && failures.has(failure)) { code = 503; result = { message: failure === "import" ? "Fixture acquisition failed." : `${failure} temporarily unavailable.` }; }
  if (path.endsWith("/setup") && params.has("setup-failure") && calls.filter(call => call.path.endsWith("/setup")).length > 1) {
    code = 503;
    result = { message: "Setup could not be checked." };
  }
  const snapshot = code === 204 ? null : JSON.stringify(result);
  if (path.endsWith("/status") && holdStatus) {
    holdStatus = false;
    await new Promise<void>(resolve => Object.assign(window, { releaseAudibleStatus: resolve }));
  }
  return new Response(snapshot, { status: code, headers: { "Content-Type": "application/json" } });
};

function Fixture() {
  const [books, setBooks] = useState<LibationBook[]>([]);
  const [loaded, setLoaded] = useState(false);
  const currentUser: AuthUser = {
    id: "owner", username: "Owner", isAdmin: !params.has("reader"), isOwner: !params.has("reader"),
    canApproveLibationRequests: true, allowedBookIds: null, libationAccess: params.has("reader") ? "approval" : "direct",
    shareProgress: true, announceFinishes: true, notifyFinishes: true
  };
  const purchases = usePurchases({
    capabilities: serverCapabilities("operalibre", currentUser), currentUser, demoMode: false, isOperaLibre: true,
    libationBooks: books, libationBooksLoaded: loaded, librarySource: "audible", loadBooks, localMode: false, native,
    onCurrentUserChanged: () => undefined, searchQuery: "", setLibationBooks: setBooks, setLibationBooksLoaded: setLoaded,
    sortMode: "title", sortReversed: false
  });
  Object.assign(window, { refreshAudibleCatalog: () => purchases.loadLibationBooks(false) });
  const management = <AudibleManagement currentUser={currentUser} native={native} purchases={purchases} />;
  return <main className={native ? "settings-card purchase-provider-settings" : "library-pane open"} style={native ? { maxWidth: 700, margin: "24px auto", padding: 24 } : { width: "min(380px, 100%)", minHeight: "100dvh", padding: 24 }}>
    <h1>Audible</h1>
    {management}
    {params.has("catalog") ? <section aria-label="Cached Audible purchases">
      <label>Account filter<select aria-label="Account filter" value={purchases.audibleAccountFilter} onChange={event => purchases.setAudibleAccountFilter(event.currentTarget.value)}><option value="all">All accounts</option>{purchases.allAudibleAccounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Combined account filter<select aria-label="Combined account filter" value={purchases.purchaseAccountFilter} onChange={event => purchases.setPurchaseAccountFilter(event.currentTarget.value)}><option value="all">All accounts</option>{purchases.allAudibleAccounts.map(item => <option key={item.id} value={`audible:${item.id}`}>{item.name}</option>)}</select></label>
      <ul>{purchases.visibleLibationBooks.map(book => <li key={book.catalogId}>{book.title} — {book.profileName}</li>)}</ul>
    </section> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
