import assert from "node:assert/strict";
import test from "node:test";
import { dropRemovedServerConnection } from "../src/removedServers.ts";

function storage(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key); }
  };
}

const savedConnection = {
  "operalibre.serverUrl": "https://media.example",
  "operalibre.serverIdentityUrl": "https://media.example",
  "operalibre.serverId": "f00d",
  "operalibre.serverAliases": JSON.stringify([{ id: "a", name: "Home", url: "http://192.168.1.2:8096" }])
};
const connectionKeys = Object.keys(savedConnection);
const preferences = {
  "operalibre.playbackSpeed": "1.25",
  "operalibre.credentials.v2": "{}"
};

test("a saved Jellyfin connection is forgotten so the app opens at the server picker", () => {
  const store = storage({
    ...savedConnection,
    ...preferences,
    "operalibre.serverType": "jellyfin",
    "operalibre.jellyfinDeviceId": "device"
  });
  assert.equal(dropRemovedServerConnection(store, connectionKeys), true);
  for (const key of [...Object.keys(savedConnection), "operalibre.serverType", "operalibre.jellyfinDeviceId"]) {
    assert.equal(store.getItem(key), null, key);
  }
  // Reading preferences survive; sign-ins are forgotten by the caller's vault.
  assert.deepEqual(Object.fromEntries(store.values), preferences);
  // The leftover key is gone, so a second launch connects normally.
  assert.equal(dropRemovedServerConnection(store, connectionKeys), false);
});

test("any other unsupported server kind is forgotten the same way", () => {
  const store = storage({ ...savedConnection, "operalibre.serverType": "something-else" });
  assert.equal(dropRemovedServerConnection(store, connectionKeys), true);
  assert.equal(store.getItem("operalibre.serverUrl"), null);
});

test("an OperaLibre connection, with or without the old key, is left alone", () => {
  for (const extra of [{ "operalibre.serverType": "operalibre" }, {}]) {
    const store = storage({ ...savedConnection, ...extra });
    assert.equal(dropRemovedServerConnection(store, connectionKeys), false);
    assert.deepEqual(Object.fromEntries(store.values), savedConnection);
  }
});

test("a fresh install has nothing to forget", () => {
  const store = storage({});
  assert.equal(dropRemovedServerConnection(store, connectionKeys), false);
  assert.equal(store.values.size, 0);
});
