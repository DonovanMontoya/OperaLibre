export type GiftLink = { broker: string; token: string; previewKey?: string; signingKey?: string; giftId?: string };
export type NativeGiftLaunch = { originalUrl: string; link: GiftLink };

/** Build-time domain declarations must also exist in the native entitlement /
 * manifest and on that exact domain. This parser cannot verify that ownership.
 * Stock builds default to no HTTPS domains, never a wildcard owner domain. */
export function parseGiftAssociatedOrigins(raw: unknown): readonly string[] {
  if (raw === undefined || raw === "") return [];
  try {
    if (typeof raw !== "string" || raw.length > 2048) return [];
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > 4 || new Set(entries).size !== entries.length) return [];
    for (const value of entries) {
      if (typeof value !== "string" || value.length > 512 || /[^\x21-\x7e]/.test(value)) return [];
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== value || url.port || url.username || url.password || !url.hostname.includes(".") || url.hostname.includes("*") || url.hostname.endsWith(".") || url.hostname.startsWith("[") || /^[0-9.]+$/.test(url.hostname)) return [];
    }
    return entries;
  } catch { return []; }
}

/** Private credentials are bounded before URLSearchParams allocation. Never
 * interpret these fields as login details or a server-configuration request. */
export function parseExperimentalGiftFragment(fragment: string): GiftLink | null {
  const raw = fragment.replace(/^#/, "");
  if (!raw || raw.length > 8192 || /[^A-Za-z0-9_%&=.:/-]/.test(raw) || /%(?![a-fA-F0-9]{2})/.test(raw)) return null;
  const params = new URLSearchParams(raw);
  // URLSearchParams decodes escapes. Avoid `$` anchors, which also match before
  // a final line terminator; every decoded character must be in the alphabet.
  const canonical = (value: string, min: number, max: number) => value.length >= min && value.length <= max && !/[^A-Za-z0-9_-]/.test(value);
  if ([...params.keys()].some(key => !["gift", "broker", "key", "signing", "id"].includes(key)) || params.getAll("gift").length !== 1 || params.getAll("broker").length !== 1 || params.getAll("key").length > 1 || params.getAll("signing").length > 1 || params.getAll("id").length > 1) return null;
  const token = params.get("gift") ?? "";
  if (!canonical(token, 32, 4096)) return null;
  const previewKey = params.get("key"), signingKey = params.get("signing");
  // An opaque recovery lookup hint, not authorization. Recovery secrets never
  // belong in shared links; the verified preview must confirm this ID later.
  const giftId = params.get("id");
  if (giftId !== null && !canonical(giftId, 16, 128)) return null;
  if ((previewKey !== null) !== (signingKey !== null) || (previewKey !== null && !canonical(previewKey, 43, 43)) || (signingKey !== null && !canonical(signingKey, 43, 43))) return null;
  try {
    const brokerValue = params.get("broker") ?? "";
    if (/[\u0000-\u0020\u007f]/.test(brokerValue)) return null;
    const broker = new URL(brokerValue);
    if (broker.protocol !== "https:" || broker.username || broker.password || broker.pathname !== "/" || broker.search || broker.hash) return null;
    return { broker: broker.origin, token, ...(previewKey && signingKey ? { previewKey, signingKey } : {}), ...(giftId !== null ? { giftId } : {}) };
  } catch { return null; }
}

/** Construct only an owner-controlled HTTPS landing link. Optional ID is a
 * locator; no native recovery secret or authorization context is serialized. */
export function createExperimentalGiftLink(landing: string, link: GiftLink): string {
  const url = new URL(landing);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !link.previewKey || !link.signingKey) throw new Error("Invalid gift link configuration");
  const params = new URLSearchParams({ gift: link.token, broker: link.broker, key: link.previewKey, signing: link.signingKey });
  if (link.giftId !== undefined) params.set("id", link.giftId);
  if (!parseExperimentalGiftFragment(params.toString())) throw new Error("Invalid gift link credentials");
  url.pathname = "/gift";
  url.hash = params.toString();
  return url.toString();
}

/** Only the exact custom authority is registered. Reject normalization tricks,
 * query credentials, ports, userinfo, alternate hosts and paths before parsing.
 * Keep the original private URI in memory; do not replace it with a server URL. */
export function parseNativeGiftUrl(value: string, associatedOrigins: readonly string[] = []): NativeGiftLaunch | null {
  if (typeof value !== "string" || value.length > 16384 || /[^\x21-\x7e]/.test(value)) return null;
  let fragment: string;
  if (value.startsWith("operalibre://gift#")) fragment = value.slice("operalibre://gift".length);
  else {
    // A configured domain is routing context, never broker authorization. Keep
    // the original fragment and require exact spelling to reject normalization
    // tricks (userinfo, path escapes, queries and non-default ports).
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !associatedOrigins.includes(url.origin) || value !== `${url.origin}/gift${url.hash}` || url.pathname !== "/gift" || !url.hash) return null;
      fragment = url.hash;
    } catch { return null; }
  }
  const link = parseExperimentalGiftFragment(fragment);
  if (!link?.previewKey || !link.signingKey) return null;
  return { originalUrl: value, link };
}

export type NativeGiftApp = {
  addListener(event: "appUrlOpen", listener: (event: { url: string }) => void): Promise<{ remove(): Promise<void> }>;
  getLaunchUrl(): Promise<{ url: string } | undefined>;
};

/** Subscribe before reading cold launch so a newer warm event wins. Cleanup is
 * safe even while the native listener promise is pending (React StrictMode). */
export function watchNativeGiftLinks(app: NativeGiftApp, onGift: (launch: NativeGiftLaunch) => void, onReady: () => void, associatedOrigins: readonly string[] = []): () => void {
  let active = true;
  let receivedEvent = false;
  let handle: { remove(): Promise<void> } | undefined;
  const receive = (value: string, event: boolean) => {
    if (!active) return;
    const launch = parseNativeGiftUrl(value, associatedOrigins);
    if (!launch) return;
    if (event) receivedEvent = true;
    onGift(launch);
  };
  void (async () => {
    try {
      handle = await app.addListener("appUrlOpen", event => receive(event.url, true));
      if (!active) { await handle.remove(); return; }
      const launch = await app.getLaunchUrl();
      if (!receivedEvent && launch) receive(launch.url, false);
    } catch {
      // A missing bridge or unsupported native method must not gate the normal
      // local library. Never log an error containing the private launch URL.
    } finally {
      if (active) onReady();
    }
  })();
  return () => { active = false; if (handle) void handle.remove().catch(() => {}); };
}
