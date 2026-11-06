import { giftBrokerOrigin } from "./giftBrokerOrigin.ts";

export type GiftConnectivity = { iceServers: { urls: string[]; turnRestSecret?: string }[]; relayAllowed: boolean; requireRelay: boolean };
export type GiftOwnerConfiguration = { configured: boolean; brokerOrigin: string | null; ownerSecretConfigured: boolean; allowReaders: boolean; productionEnabled: false; connectivity: { iceServers: { urls: string[]; usernameConfigured: boolean; credentialConfigured: boolean; turnRestSecretConfigured: boolean }[]; relayAllowed: boolean; requireRelay: boolean } };
export type GiftOwnerConfigurationRequest = { brokerOrigin: string; ownerSecret?: string; allowReaders: boolean; ownerControlsBroker: true; connectivity?: GiftConnectivity };

function udpIceUrl(value: string, kind: "stun" | "turn"): string {
  const fail = () => new Error(`Enter a ${kind === "turn" ? "UDP coturn TURN" : "UDP STUN"} URL with a host and explicit port; TCP/TLS, credentials and extra URL components are unsupported.`);
  if (!value || value.length > 512 || /[^\x21-\x7e]|[@#/%\\]/.test(value)) throw fail();
  const match = /^(stun|turn):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+):([0-9]{1,5})(\?transport=udp)?$/.exec(value);
  if (!match || match[0] !== value || match[1] !== kind || +match[3] < 1 || +match[3] > 65535 || (kind === "stun" && match[4]) || (kind === "turn" && !match[4])) throw fail();
  const host = match[2];
  if (host.startsWith("[")) {
    try { new URL(`http://${host}`); } catch { throw fail(); }
  } else if (host.length > 253 || host.replace(/\.$/, "").split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) throw fail();
  return value;
}

/** Editing is a full replacement, never a reconstruction from redacted flags.
 * The unchecked path omits the entire private connectivity configuration. */
export function giftConnectivityEdit(input: { changeIce: boolean; stunUrl: string; turnUrl: string; turnRestSecret: string; relayAllowed: boolean; requireRelay: boolean }): GiftConnectivity | undefined {
  if (!input.changeIce) return undefined;
  if (input.requireRelay && (!input.relayAllowed || !input.turnUrl)) throw new Error("Requiring relay needs relay permission and a UDP coturn TURN URL.");
  if (input.relayAllowed && !input.turnUrl) throw new Error("Enter a UDP coturn TURN URL, or turn off relay permission for STUN/host-only configuration.");
  const iceServers: GiftConnectivity["iceServers"] = [];
  if (input.stunUrl) iceServers.push({ urls: [udpIceUrl(input.stunUrl, "stun")] });
  if (input.turnUrl) {
    const url = udpIceUrl(input.turnUrl, "turn");
    if (!input.relayAllowed) throw new Error("Allow relay explicitly before configuring a UDP coturn TURN URL.");
    if (input.turnRestSecret.length < 32 || input.turnRestSecret.length > 512 || /[^\x21-\x7e]/.test(input.turnRestSecret)) throw new Error("Re-enter the full coturn TURN REST shared secret: 32–512 printable ASCII characters without spaces. Configured markers and masked placeholders cannot supply it.");
    iceServers.push({ urls: [url], turnRestSecret: input.turnRestSecret });
  } else if (input.turnRestSecret) throw new Error("A coturn TURN REST secret needs a UDP TURN URL. Clear it before saving STUN/host-only settings.");
  return { iceServers, relayAllowed: input.relayAllowed, requireRelay: input.requireRelay };
}

/** Return only the documented redacted projection. Never retain a raw response
 * that might contain a private credential from an incompatible server. */
export function parseGiftOwnerConfiguration(value: unknown): GiftOwnerConfiguration {
  if (!value || typeof value !== "object") throw new Error("Gift setup could not be read.");
  const v = value as GiftOwnerConfiguration;
  if (typeof v.configured !== "boolean" || typeof v.ownerSecretConfigured !== "boolean" || typeof v.allowReaders !== "boolean" || v.productionEnabled !== false || (v.brokerOrigin !== null && giftBrokerOrigin(v.brokerOrigin) !== v.brokerOrigin) || (v.configured && !v.brokerOrigin) || !v.connectivity || typeof v.connectivity.relayAllowed !== "boolean" || typeof v.connectivity.requireRelay !== "boolean" || !Array.isArray(v.connectivity.iceServers) || v.connectivity.iceServers.length > 4) throw new Error("Gift setup could not be read.");
  const iceServers = v.connectivity.iceServers.map(server => {
    if (!Array.isArray(server.urls) || server.urls.length > 4 || server.urls.some(url => typeof url !== "string" || url.length > 512 || /[\u0000-\u0020\u007f]/.test(url)) || typeof server.usernameConfigured !== "boolean" || typeof server.credentialConfigured !== "boolean" || typeof server.turnRestSecretConfigured !== "boolean") throw new Error("Gift setup could not be read.");
    return { urls: [...server.urls], usernameConfigured: server.usernameConfigured, credentialConfigured: server.credentialConfigured, turnRestSecretConfigured: server.turnRestSecretConfigured };
  });
  return { configured: v.configured, brokerOrigin: v.brokerOrigin, ownerSecretConfigured: v.ownerSecretConfigured, allowReaders: v.allowReaders, productionEnabled: false, connectivity: { iceServers, relayAllowed: v.connectivity.relayAllowed, requireRelay: v.connectivity.requireRelay } };
}

export function giftOwnerConfigurationRequest(input: { brokerInput: string; ownerSecret: string; allowReaders: boolean; ownerConfirmed: boolean; existing: GiftOwnerConfiguration }): GiftOwnerConfigurationRequest {
  const origin = giftBrokerOrigin(input.brokerInput);
  if (!origin || input.brokerInput.length > 512 || /[\u0000-\u0020\u007f]/.test(input.brokerInput) || !input.ownerConfirmed) throw new Error("Confirm an owner-controlled HTTPS broker origin without credentials, a path, query or fragment.");
  const secret = input.ownerSecret;
  if (secret && (secret.length < 32 || secret.length > 1024 || /[^\x21-\x7e]/.test(secret))) throw new Error("The owner secret must be 32–1024 printable ASCII characters without spaces.");
  if (!secret && (!input.existing.ownerSecretConfigured || origin !== input.existing.brokerOrigin)) throw new Error("Enter the broker owner secret for a new setup or changed broker origin.");
  return { brokerOrigin: origin, ...(secret ? { ownerSecret: secret } : {}), allowReaders: input.allowReaders, ownerControlsBroker: true };
}
