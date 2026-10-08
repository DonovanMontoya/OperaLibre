import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";

for (const message of ["Permission denied reading the audio file", "File picker cancelled"]) {
  test(`device import notice: ${message}`, async () => {
    const notices: unknown[] = [];
    const activity: unknown[] = [];
    const useOfflineDownloads = loadHook("useOfflineDownloads", {
      react: { useRef: (current: unknown) => ({ current }), useEffect: () => {}, useMemo: (run: () => unknown) => run(), useState: (value: unknown) => [value, () => {}] },
      "./offline": {}, "./api": { getServerStorageKey: () => "fixture" },
      "./offlineReadiness": {},
      "./formatting": { errorMessage: (error: Error) => error.message },
      "./localLibrary": { importAudiobookFromDevice: async () => { throw new Error(message); } }
    });
    const hook = useOfflineDownloads({
      books: [],
      downloadStatus: { message: "Earlier failure", source: "deviceImport" },
      setDownloadStatus: (notice: unknown) => notices.push(notice),
      setDeviceImport: (value: unknown) => activity.push(value)
    });
    await hook.importFromDevice();
    assert.equal(notices[0], null, "a new attempt clears the previous notice");
    assert.deepEqual(activity, [{ completed: 0, total: 0 }, null]);
    if (/cancel/i.test(message)) assert.deepEqual(notices, [null]);
    else assert.deepEqual(notices[1], { message, source: "deviceImport" });
    // The returned notice is the same prop rendered by the shelf entry point.
    assert.deepEqual(hook.downloadStatus, { message: "Earlier failure", source: "deviceImport" });
  });
}
