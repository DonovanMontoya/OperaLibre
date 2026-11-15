import { test } from "node:test";
import { strict as assert } from "node:assert";
import { giftBrokerOrigin, giftBrokerTransportSecure } from "./giftBrokerOrigin.ts";

test("accepts only HTTPS broker origins without credentials or URL components", () => {
  assert.equal(giftBrokerOrigin(" https://Broker.Example:443/ "), "https://broker.example");
  for (const value of ["", "http://broker.example", "https://user:pass@broker.example", "https://broker.example/path", "https://broker.example/?x=1", "https://broker.example/?", "https://broker.example/#fragment", "https://broker.example/#", "not a URL"]) {
    assert.equal(giftBrokerOrigin(value), null, value);
  }
});

test("requires HTTPS to the actual server and a secure HTTPS page, excluding development proxies", () => {
  const page = "https://app.example/";
  assert.equal(giftBrokerTransportSecure("https://server.example", page, true, true), true);
  assert.equal(giftBrokerTransportSecure("http://100.64.0.1:4920", page, true, true), false);
  assert.equal(giftBrokerTransportSecure("http://server.example", page, true, true), false);
  assert.equal(giftBrokerTransportSecure("https://server.example", "http://localhost:5173", true, true), false);
  assert.equal(giftBrokerTransportSecure("https://server.example", page, false, true), false);
  assert.equal(giftBrokerTransportSecure("https://app.example", page, true, true), false);
  assert.equal(giftBrokerTransportSecure("https://app.example", page, true, false), true);
  assert.equal(giftBrokerTransportSecure("/api", page, true, true), false);
});
