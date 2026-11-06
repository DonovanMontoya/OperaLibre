import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createNativeGiftStagingManager, type NativeGiftStagingBackend } from "../src/giftNativeStaging.ts";

const giftId = "gift____________";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  // Simulate one native authority shared by independent WebViews. Platform
  // instrumentation tests exercise the real OS locks and file operations.
  const archives = new Map<string, Uint8Array>();
  const records = new Set<string>();
  const held = new Map<string, { token: string; owner: string; maximum: number; verified: boolean }>();
  const calls: string[] = [];
  let sequence = 0, pause: ReturnType<typeof deferred> | undefined;
  const started = deferred();
  function backend(owner: string): NativeGiftStagingBackend {
    function owned(id: string, token: string) {
      const value = held.get(id);
      if (!value || value.owner !== owner || value.token !== token) throw new Error("stale or foreign lease");
      return value;
    }
    return {
      async acquireArchive({ giftId: id, create, maximumSize }) {
        calls.push("acquire");
        if (held.has(id)) throw new Error("native transfer active");
        const prior = archives.get(id);
        if (create && ((prior?.length ?? 0) !== 0 || records.has(id))) throw new Error("ambiguous fresh state");
        const bytes = prior ?? (create ? new Uint8Array() : undefined);
        if (!bytes || bytes.length > maximumSize) throw new Error("unavailable prefix");
        archives.set(id, bytes);
        const token = Buffer.alloc(32, ++sequence).toString("base64url");
        held.set(id, { token, owner, maximum: maximumSize, verified: false });
        return { lease: token, offset: bytes.length, prefixSha256: hash(bytes) };
      },
      async appendArchive({ giftId: id, lease, offset, data }) {
        const value = owned(id, lease), before = archives.get(id)!;
        const bytes = new Uint8Array(Buffer.from(data, "base64"));
        if (value.verified || offset !== before.length || !bytes.length || bytes.length > 65536 || offset + bytes.length > value.maximum) throw new Error("invalid native append");
        calls.push("append"); started.resolve(); await pause?.promise;
        archives.set(id, Uint8Array.from([...before, ...bytes]));
        return { offset: offset + bytes.length };
      },
      async verifyArchive({ giftId: id, lease, size, sha256 }) {
        const value = owned(id, lease), bytes = archives.get(id)!;
        if (size !== bytes.length || hash(bytes) !== sha256) throw new Error("digest mismatch");
        value.verified = true; calls.push("verify");
      },
      async releaseArchive({ giftId: id, lease }) { owned(id, lease); held.delete(id); calls.push("release"); },
      async cleanupArchive({ giftId: id }) {
        if (held.has(id)) throw new Error("native transfer active");
        archives.delete(id); records.delete(id); calls.push("cleanup");
      }
    };
  }
  return { backend, archives, records, held, calls, started, pauseAppend: () => { pause = deferred(); return pause; } };
}

test("native lease excludes independent WebViews through verify and rejects stale or foreign tokens", async () => {
  const f = fixture(), firstBackend = f.backend("first"), otherBackend = f.backend("other");
  const first = createNativeGiftStagingManager(firstBackend, () => true), other = createNativeGiftStagingManager(otherBackend, () => true);
  f.archives.set(giftId, new Uint8Array([1, 2]));
  const { prefix, staging } = await first.recover(giftId, 4);
  assert.equal(prefix.offset, 2);
  const old = f.held.get(giftId)!.token;
  await assert.rejects(other.recover(giftId, 4), /active/);
  await assert.rejects(otherBackend.appendArchive({ giftId, lease: old, offset: 2, data: "Aw==" }), /foreign/);
  await assert.rejects(firstBackend.appendArchive({ giftId, lease: old, offset: 0, data: "Aw==" }), /append/);
  await staging.append(2, new Uint8Array([3, 4]));
  await staging.finish(4, hash(new Uint8Array([1, 2, 3, 4])));
  await assert.rejects(other.cleanup(giftId), /active/);
  await assert.rejects(staging.append(4, new Uint8Array([5])), /offset/);
  await staging.close(); await staging.close();
  const next = await other.recover(giftId, 4);
  await assert.rejects(firstBackend.releaseArchive({ giftId, lease: old }), /stale/);
  await staging.close(); assert.equal(f.held.get(giftId)!.owner, "other");
  await next.staging.close(); await other.cleanup(giftId);
  assert.equal(f.archives.has(giftId), false);
  assert.equal(f.calls.filter(call => call === "release").length, 2);
});

test("close waits for native append before releasing ownership", async () => {
  const f = fixture(), backend = f.backend("first"), gate = f.pauseAppend();
  const manager = createNativeGiftStagingManager(backend, () => true);
  const staging = await manager.create(giftId);
  const writing = staging.append(0, new Uint8Array([7])); await f.started.promise;
  const closing = staging.close();
  await assert.rejects(manager.cleanup(giftId), /active/);
  assert.equal(f.calls.includes("release"), false);
  gate.resolve(); await writing; await closing;
  assert.equal(f.calls.at(-1), "release");
  assert.deepEqual(f.archives.get(giftId), new Uint8Array([7]));
});

test("fresh creation reuses only empty orphans with no recovery state and never truncates", async () => {
  const f = fixture(), manager = createNativeGiftStagingManager(f.backend("first"), () => true);
  f.archives.set(giftId, new Uint8Array());
  const staging = await manager.create(giftId); await staging.close();
  f.records.add(giftId);
  await assert.rejects(manager.create(giftId), /ambiguous/);
  f.records.delete(giftId); f.archives.set(giftId, new Uint8Array([1]));
  await assert.rejects(manager.create(giftId), /ambiguous/);
  assert.deepEqual(f.archives.get(giftId), new Uint8Array([1]));
});

test("prefix failure releases its native lease and failed verification does not delete the prefix", async () => {
  const f = fixture(), backend = f.backend("first");
  f.archives.set(giftId, new Uint8Array([1]));
  const manager = createNativeGiftStagingManager({ ...backend, async acquireArchive(input) {
    return { ...await backend.acquireArchive(input), offset: 9 };
  } }, () => true);
  await assert.rejects(manager.recover(giftId, 4), /prefix/);
  assert.equal(f.held.size, 0);
  const good = createNativeGiftStagingManager(backend, () => true);
  const recovered = await good.recover(giftId, 4);
  await assert.rejects(recovered.staging.finish(1, "a".repeat(64)), /digest/);
  await recovered.staging.close();
  assert.deepEqual(f.archives.get(giftId), new Uint8Array([1]));
});

test("inspection releases its transient native lease and chunks stay bounded", async () => {
  const f = fixture(), manager = createNativeGiftStagingManager(f.backend("first"), () => true);
  f.archives.set(giftId, new Uint8Array([1]));
  assert.equal((await manager.inspect(giftId, 4)).offset, 1); assert.equal(f.held.size, 0);
  const { staging } = await manager.recover(giftId, 4);
  for (const bytes of [new Uint8Array(), new Uint8Array(65537)]) await assert.rejects(staging.append(1, bytes), /offset/);
  await staging.close();
  for (const id of ["../gift____________", "gift____________\n"]) await assert.rejects(manager.cleanup(id), /unavailable/);
});
