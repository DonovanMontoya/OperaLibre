import assert from "node:assert/strict";
import test from "node:test";
import {
  isPrivateServerHostname,
  normalizeServerAddress,
  requireSecurePublicServerAddress,
  upgradeStoredNativeServerAddress
} from "../src/serverAddress.ts";

test("recognizes local, LAN, and private overlay addresses", () => {
  for (const hostname of [
    "localhost", "bookshelf", "books.local", "books.home.arpa", "books.tailnet.ts.net",
    "10.0.0.2", "172.16.4.2", "172.31.255.254", "192.168.1.5", "100.64.0.1",
    "100.127.255.254", "127.0.0.1", "169.254.2.3", "::1", "fd12:3456::1", "fe80::1"
  ]) {
    assert.equal(isPrivateServerHostname(hostname), true, hostname);
  }
});

test("does not mistake public addresses for private ones", () => {
  for (const hostname of [
    "books.example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888"
  ]) {
    assert.equal(isPrivateServerHostname(hostname), false, hostname);
  }
});

test("scheme-less private addresses stay easy while public names default to HTTPS", () => {
  assert.equal(normalizeServerAddress("192.168.1.20:4000/"), "http://192.168.1.20:4000");
  assert.equal(normalizeServerAddress("My-Mac.local:4000"), "http://my-mac.local:4000");
  assert.equal(normalizeServerAddress("books.example.com"), "https://books.example.com");
  assert.equal(normalizeServerAddress("https://books.example.com/"), "https://books.example.com");
});

test("native clients reject explicit public HTTP", () => {
  assert.throws(
    () => requireSecurePublicServerAddress("http://books.example.com"),
    /must use HTTPS/
  );
  assert.equal(
    requireSecurePublicServerAddress("http://192.168.1.20:4000"),
    "http://192.168.1.20:4000"
  );
});

test("legacy public HTTP addresses are upgraded without changing private HTTP", () => {
  assert.equal(
    upgradeStoredNativeServerAddress("http://books.example.com"),
    "https://books.example.com"
  );
  assert.equal(
    upgradeStoredNativeServerAddress("http://10.0.0.2:4000"),
    "http://10.0.0.2:4000"
  );
});
