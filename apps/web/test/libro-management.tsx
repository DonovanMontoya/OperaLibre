import { createRoot } from "react-dom/client";
import { LibroCatalog } from "../src/LibroCatalog";
import type { JobStatus, LibroAccountStatus } from "../src/types";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const native = params.has("native");
const admin = params.has("admin");
if (native) document.documentElement.classList.add("native-app", "platform-ios");
if (params.has("dark")) document.documentElement.classList.add("dark-mode");
const emails = ["personal@example.test", "family@example.test"];
const fixtureBooks: LibroAccountStatus["books"] = emails.map((email, index) => ({
  accountEmail: email, isbn: index ? "9780000000002" : "9780000000001", title: index ? "Second Purchase" : "First Purchase",
  authors: ["Fixture Author"], cover_url: null, audiobook_info: { narrators: ["Fixture Narrator"], duration: 240 }, description: "", localBookId: null
}));
let status: LibroAccountStatus = {
  connected: !params.has("empty"), email: params.has("empty") ? null : emails[0], syncedAt: "2026-10-01T12:00:00Z",
  accounts: params.has("empty") ? [] : emails.slice(0, params.has("multiple") ? 2 : 1).map((email, index) => ({ email, nickname: index ? "Family" : "Personal", syncedAt: "2026-10-01T12:00:00Z" })),
  books: params.has("empty") ? [] : fixtureBooks.slice(0, params.has("multiple") ? 2 : 1), jobs: []
};
const calls: { path: string; method: string; body: unknown; }[] = [];
Object.assign(window, { libroCalls: calls });
const actualFetch = window.fetch;
window.fetch = async (input, init) => {
  const requestUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const path = requestUrl.pathname;
  if (!path.startsWith("/api/me/libro") && path !== "/api/books") return actualFetch(input, init);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ path: path + requestUrl.search, method, body });
  let result: unknown = status;
  let code = 200;
  if (path === "/api/books") result = [];
  else if (path === "/api/me/libro" && method === "POST") {
    if (params.has("failure")) { code = 401; result = { message: "Libro.fm sign-in failed. Check your email and password." }; }
    else {
      const accounts = status.accounts!.some(account => account.email === body.email) ? status.accounts! : [...status.accounts!, { email: body.email, syncedAt: null }];
      status = { ...status, connected: true, email: accounts[0].email, accounts, books: fixtureBooks.filter(book => accounts.some(account => account.email === book.accountEmail)) };
      result = { jobId: "fixture-connect" };
    }
  } else if (path === "/api/me/libro" && method === "PATCH") {
    status = { ...status, accounts: status.accounts!.map(account => account.email === body.email ? { ...account, nickname: body.nickname } : account) };
    code = 204;
  } else if (path === "/api/me/libro" && method === "DELETE") {
    const accounts = status.accounts!.filter(account => account.email !== requestUrl.searchParams.get("email"));
    status = { ...status, accounts, connected: accounts.length > 0, email: accounts[0]?.email ?? null, books: status.books.filter(book => accounts.some(account => account.email === book.accountEmail)) };
    code = 204;
  } else if (path.endsWith("/refresh")) {
    const job: JobStatus = { id: "fixture-refresh", kind: "libro-refresh", targetId: null, status: params.has("refresh-failure") ? "failed" : "completed", startedAt: "2026-10-01T12:00:00Z", finishedAt: "2026-10-01T12:00:01Z", exitCode: 0, output: "", error: params.has("refresh-failure") ? "Libro.fm connection expired. Reconnect your account." : null };
    status = { ...status, jobs: [job] };
    result = { jobId: job.id };
  } else if (path.endsWith("/import")) result = { jobId: "fixture-import" };
  return new Response(code === 204 ? null : JSON.stringify(result), { status: code, headers: { "Content-Type": "application/json" } });
};

const catalog = <LibroCatalog mode={native && !admin ? "management" : "full"} viewMode={admin ? undefined : "list"} searchQuery={admin ? undefined : ""} onBooksChanged={() => undefined} />;
createRoot(document.getElementById("root")!).render(admin ? <main className="admin-shell"><div /><div className="admin-content">{catalog}</div></main> : <main className={native ? "settings-card purchase-provider-settings" : "library-pane open"} style={native ? { maxWidth: 700, margin: "24px auto", padding: 24 } : { width: "min(380px, 100%)", minHeight: "100dvh", padding: 24 }}>
  {catalog}
</main>);
