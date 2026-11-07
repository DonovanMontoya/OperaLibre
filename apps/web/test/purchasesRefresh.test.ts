import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";
import * as audibleBooks from "../src/audibleBooks.ts";
import * as jobLabels from "../src/jobLabels.ts";
import * as libationState from "../src/libationState.ts";
import { serverCapabilities } from "../src/serverCapabilities.ts";
import type { JobCreated, LibationAccess, LibationAccount, LibationStatus, ServerType } from "../src/types.ts";

const noop = () => {};
const signedIn: LibationAccount = {
  id: "account", accountId: "owner", name: null, locale: "us", scanLibrary: true,
  authenticated: true, managed: true, connectionState: "connected",
  lastSuccessfulAuth: null, lastSuccessfulRefresh: null, lastError: null, addedBy: null, addedAt: null
};
const connectedStatus: LibationStatus = {
  enabled: true, cliPath: null, libationFilesDir: null, libraryRoot: "", accounts: [signedIn],
  authenticated: true, message: null, autoRefreshHours: 24, manualRefreshesPerHour: 3
};

function fixture({
  admin = false, native = true, enabled = true, canCheckAudible = true, access = "approval", status = connectedStatus,
  localMode = false, demoMode = false, server = "operalibre", sync = async () => ({ jobId: "refresh" })
}: {
  admin?: boolean; native?: boolean; enabled?: boolean; canCheckAudible?: boolean | null; access?: LibationAccess; status?: LibationStatus;
  localMode?: boolean; demoMode?: boolean; server?: ServerType; sync?: () => Promise<JobCreated>;
} = {}) {
  const states: unknown[] = [], refs: unknown[] = [];
  let stateIndex = 0, refIndex = 0;
  const counts = { syncs: 0, reads: 0, access: 0, status: 0 };
  const hook = loadHook("usePurchases", {
    react: {
      useState(initial: unknown) {
        const index = stateIndex++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (value: unknown) => {
          states[index] = typeof value === "function" ? value(states[index]) : value;
        }];
      },
      useRef(initial: unknown) {
        const index = refIndex++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
      useCallback: (fn: unknown) => fn, useEffect: noop, useMemo: (fn: () => unknown) => fn()
    },
    "./audibleBooks": audibleBooks,
    "./jobLabels": jobLabels,
    "./libationState": libationState,
    "./libroDevice": { supportsLibroDevice: () => true },
    "./formatting": {
      formatLibationMessage: () => null,
      errorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
    },
    "./api": {
      getLibationAccess: async () => {
        counts.access++;
        return { enabled, ...(canCheckAudible === null ? {} : { canCheckAudible }), libationAccess: access, autoRefreshHours: 24, manualRefreshesPerHour: 3 };
      },
      getLibationStatus: async () => { counts.status++; return status; },
      getLibationBooks: async () => { counts.reads++; return []; },
      syncLibationLibrary: async () => { counts.syncs++; return sync(); }
    }
  });
  function render() {
    stateIndex = 0;
    refIndex = 0;
    return hook({
      capabilities: serverCapabilities(server, { isAdmin: admin }, { local: localMode, demo: demoMode }),
      currentUser: { id: admin ? "admin" : "reader", isAdmin: admin, libationAccess: access },
      demoMode, isOperaLibre: server === "operalibre", libationBooks: [], libationBooksLoaded: true,
      librarySource: "audible", loadBooks: async () => {}, localMode, native,
      onCurrentUserChanged: noop, searchQuery: "", setLibationBooks: noop, setLibationBooksLoaded: noop,
      sortMode: "title", sortReversed: false
    });
  }
  return { render, counts };
}

test("reader Get books refresh checks Audible using access without fetching accounts", async (t) => {
  for (const access of ["approval", "direct"] satisfies LibationAccess[]) {
    await t.test(access, async () => {
      const f = fixture({ access });
      await f.render().loadLibationStatus();
      const purchases = f.render();
      assert.equal(purchases.canBrowseLibation, true);
      assert.deepEqual(purchases.libationStatus.accounts, []);
      await purchases.refreshAudiblePurchases();
      assert.deepEqual(f.counts, { syncs: 1, reads: 0, access: 1, status: 0 });
      assert.equal(f.render().isRefreshingAudible, true);
      assert.equal(f.render().refreshLibationJob.id, "refresh");
    });
  }
});

test("Get books refresh rereads the catalog while a check is queued", async (t) => {
  for (const admin of [false, true]) {
    await t.test(admin ? "administrator" : "reader", async () => {
      const f = fixture({ admin });
      await f.render().loadLibationStatus();
      await f.render().startLibationSync();
      assert.equal(f.render().isRefreshingAudible, true);
      await f.render().refreshAudiblePurchases();
      assert.equal(f.counts.syncs, 1);
      assert.equal(f.counts.reads, 1);
    });
  }
});

test("Get books refresh rereads the catalog while the sync request is pending", async (t) => {
  for (const admin of [false, true]) {
    await t.test(admin ? "administrator" : "reader", async () => {
      const pending = Promise.withResolvers<JobCreated>();
      const f = fixture({ admin, sync: () => pending.promise });
      await f.render().loadLibationStatus();
      const starting = f.render().startLibationSync();
      try {
        assert.equal(f.render().libationRefreshPending, true);
        await f.render().refreshAudiblePurchases();
        assert.equal(f.counts.syncs, 1);
        assert.equal(f.counts.reads, 1);
      } finally {
        pending.resolve({ jobId: "refresh" });
        await starting;
      }
    });
  }
});

test("reader refresh falls back to the catalog when browsing is unavailable", async (t) => {
  const cases = [
    { name: "Libation disabled", enabled: false },
    { name: "web browser", native: false },
    { name: "local mode", localMode: true },
    { name: "demo mode", demoMode: true },
    { name: "Jellyfin", server: "jellyfin" }
  ] satisfies (Parameters<typeof fixture>[0] & { name: string })[];
  for (const { name, ...options } of cases) {
    await t.test(name, async () => {
      const f = fixture(options);
      await f.render().loadLibationStatus();
      assert.equal(f.render().canBrowseLibation, false);
      await f.render().refreshAudiblePurchases();
      assert.equal(f.counts.syncs, 0);
      assert.equal(f.counts.reads, 1);
    });
  }
});

test("reader refresh before access is loaded only rereads the catalog", async () => {
  const f = fixture();
  await f.render().refreshAudiblePurchases();
  assert.equal(f.counts.syncs, 0);
  assert.equal(f.counts.reads, 1);
});

test("reader refresh displays the server quota rejection", async () => {
  const message = "You have used all 3 Audible refreshes for this hour.";
  const f = fixture({ sync: async () => { throw new Error(message); } });
  await f.render().loadLibationStatus();
  await f.render().refreshAudiblePurchases();
  assert.equal(f.counts.syncs, 1);
  assert.equal(f.counts.reads, 0);
  assert.equal(f.render().libationError, message);
  assert.equal(f.render().isRefreshingAudible, false);
});

test("administrator Get books refresh retains account and sign-in guards", async (t) => {
  const cases: { name: string; status: Partial<LibationStatus>; syncs: number }[] = [
    { name: "signed in", status: {}, syncs: 1 },
    { name: "disabled", status: { enabled: false }, syncs: 0 },
    { name: "no account", status: { accounts: [] }, syncs: 0 },
    { name: "signed out", status: { accounts: [{ ...signedIn, authenticated: false }] }, syncs: 0 },
    { name: "signing in", status: { accounts: [signedIn, { ...signedIn, id: "other", connectionState: "signing_in" }] }, syncs: 0 },
    { name: "pending login", status: { pendingLogin: { sessionId: "login", profileId: "account", loginUrl: "", expiresAt: 0 } }, syncs: 0 }
  ];
  for (const { name, status, syncs } of cases) {
    await t.test(name, async () => {
      const f = fixture({ admin: true, native: false, status: { ...connectedStatus, ...status } });
      await f.render().loadLibationStatus();
      await f.render().refreshAudiblePurchases();
      assert.deepEqual(f.counts, { syncs, reads: syncs ? 0 : 1, access: 0, status: syncs ? 1 : 2 });
    });
  }
});

test("reader refresh only rereads the catalog without permission to check Audible", async (t) => {
  for (const canCheckAudible of [false, null]) {
    await t.test(canCheckAudible === null ? "older server" : "no signed-in account", async () => {
      const f = fixture({ canCheckAudible });
      await f.render().loadLibationStatus();
      assert.equal(f.render().canBrowseLibation, true);
      await f.render().refreshAudiblePurchases();
      assert.deepEqual(f.counts, { syncs: 0, reads: 1, access: 2, status: 0 });
    });
  }
});
