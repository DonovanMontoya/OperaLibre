import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { GiftOwnerConfiguration, type GiftOwnerSetupApi } from "../src/GiftOwnerConfiguration";
import type { GiftOwnerConfiguration as Configuration, GiftOwnerConfigurationRequest } from "../src/giftOwnerSetupModel";
import { getGiftOwnerConfiguration, saveGiftOwnerConfiguration } from "../src/api";

const calls: { kind: string; input?: GiftOwnerConfigurationRequest; install?: { apiToken: string; accountId?: string } }[] = [];
let contextVersion = 0;
let snapshot: Configuration = { configured: true, brokerOrigin: "https://broker.example", ownerSecretConfigured: true, allowReaders: false, productionEnabled: false, connectivity: { iceServers: [{ urls: ["turn:relay.example:3478?transport=udp"], usernameConfigured: false, credentialConfigured: false, turnRestSecretConfigured: true }], relayAllowed: true, requireRelay: false } };
// `?fresh=1` starts with no broker saved, as on a server that just turned gifts on.
if (new URLSearchParams(location.search).get("fresh") === "1") snapshot = { configured: false, brokerOrigin: null, ownerSecretConfigured: false, allowReaders: false, productionEnabled: false, connectivity: { iceServers: [], relayAllowed: false, requireRelay: false } };
const api: GiftOwnerSetupApi = {
  async install(input) {
    calls.push({ kind: "install", install: { ...input } });
    if (input.apiToken !== "CLOUDFLARE_TOKEN_FOR_TEST_ONLY_1234") throw new Error("Cloudflare did not accept this token. Create a new one with the link above and paste it again.");
    snapshot = { ...snapshot, configured: true, brokerOrigin: "https://operalibre-share-broker.home.workers.dev", ownerSecretConfigured: true, connectivity: { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"], usernameConfigured: false, credentialConfigured: false, turnRestSecretConfigured: false }], relayAllowed: false, requireRelay: false } };
    return structuredClone(snapshot);
  },
  captureGuard() { const version = contextVersion; return () => version === contextVersion; },
  async load() { calls.push({ kind: "load" }); return structuredClone(snapshot); },
  async save(input) {
    calls.push({ kind: "save", input });
    snapshot = { ...snapshot, brokerOrigin: input.brokerOrigin, allowReaders: input.allowReaders, retainSenderState: input.retainSenderState ?? snapshot.retainSenderState, autoRecoverSenders: input.autoRecoverSenders ?? snapshot.autoRecoverSenders, ...(input.connectivity ? { connectivity: { relayAllowed: input.connectivity.relayAllowed, requireRelay: input.connectivity.requireRelay, iceServers: input.connectivity.iceServers.map(server => ({ urls: [...server.urls], usernameConfigured: false, credentialConfigured: false, turnRestSecretConfigured: !!server.turnRestSecret })) } } : {}) };
    return structuredClone(snapshot);
  },
  async remove() { calls.push({ kind: "delete" }); },
  async cleanup() { calls.push({ kind: "cleanup" }); return { completed: 1, pending: 0 }; },
  async recover() { calls.push({ kind: "recover" }); return { recovered: 1, alreadyActive: 0, pending: 0 }; },
  async abandon() { calls.push({ kind: "abandon" }); return { abandoned: 1, completed: 1, pending: 0 }; },
};
declare global { interface Window { ownerSetupCalls: typeof calls; testInsecureSetupCalls(): Promise<string[]>; ownerSetupChangeContext(): void } }
window.ownerSetupCalls = calls;
window.ownerSetupChangeContext = () => { contextVersion++; };
window.testInsecureSetupCalls = async () => {
  const results = [];
  for (const operation of [() => getGiftOwnerConfiguration(), () => saveGiftOwnerConfiguration({ brokerOrigin: "https://broker.example", ownerSecret: "SHOULD_NOT_SEND".repeat(4), allowReaders: false, ownerControlsBroker: true })]) {
    try { await operation(); results.push("unexpected-success"); } catch { results.push("blocked"); }
  }
  return results;
};
// Only this isolated test fixture injects a local adapter/transport result.
createRoot(document.getElementById("root")!).render(<GiftOwnerConfiguration secure={new URLSearchParams(location.search).get("secure") === "1"} api={api} />);
