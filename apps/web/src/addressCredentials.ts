import { normalizeServerAddress } from "./serverAddress.ts";

export type AddressCredentials = { token?: string; mediaToken?: string };

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CREDENTIALS_STORAGE_KEY = "operalibre.credentials";
// Where the single sign-in lived before sign-ins were kept per address.
const LEGACY_TOKEN_STORAGE_KEY = "operalibre.authToken";
const LEGACY_MEDIA_TOKEN_STORAGE_KEY = "operalibre.mediaToken";

/** One address, however it was typed. */
export function addressKey(url: string): string {
  return normalizeServerAddress(url).toLowerCase();
}

/**
 * Sign-ins, each kept under the address that issued it and readable only by
 * that address. A server reached through several addresses has one sign-in
 * per address, so a token is never sent anywhere the user did not sign in:
 * what an address says about itself cannot earn it another address's token.
 */
export class CredentialVault {
  private entries: Record<string, AddressCredentials> = {};
  /** True when this load moved a pre-vault sign-in under `legacyAddress`. */
  readonly migratedLegacySignIn: boolean = false;
  private readonly storage: KeyValueStore | null;
  private readonly persistsToken: () => boolean;

  /**
   * `persistsToken` says whether the API token may be written to storage; it
   * is always kept for the life of the page. `legacyAddress` is the address
   * the user originally signed in at, which a sign-in saved before the vault
   * is filed under.
   */
  constructor(storage: KeyValueStore | null, persistsToken: () => boolean, legacyAddress: () => string) {
    this.storage = storage;
    this.persistsToken = persistsToken;
    if (!storage) return;
    const stored = storage.getItem(CREDENTIALS_STORAGE_KEY);
    if (stored !== null) {
      this.entries = parseEntries(stored);
    } else {
      const token = persistsToken() ? storage.getItem(LEGACY_TOKEN_STORAGE_KEY) : null;
      const mediaToken = storage.getItem(LEGACY_MEDIA_TOKEN_STORAGE_KEY);
      if (token || mediaToken) {
        this.entries[addressKey(legacyAddress())] = {
          ...(token ? { token } : {}),
          ...(mediaToken ? { mediaToken } : {})
        };
        this.migratedLegacySignIn = true;
      }
    }
    // Written before the old keys go, so an interrupted load cannot lose the
    // sign-in.
    this.persist();
    storage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
    storage.removeItem(LEGACY_MEDIA_TOKEN_STORAGE_KEY);
  }

  get(url: string): AddressCredentials {
    return this.entries[addressKey(url)] ?? {};
  }

  /** Whether the user has signed in at this address. */
  has(url: string): boolean {
    const { token, mediaToken } = this.get(url);
    return !!(token || mediaToken);
  }

  /** Change one address's sign-in; a null field is removed. */
  update(url: string, change: { token?: string | null; mediaToken?: string | null }) {
    const next: AddressCredentials = { ...this.get(url) };
    for (const field of ["token", "mediaToken"] as const) {
      const value = change[field];
      if (value === undefined) continue;
      if (value) next[field] = value;
      else delete next[field];
    }
    if (next.token || next.mediaToken) {
      this.entries[addressKey(url)] = next;
    } else {
      delete this.entries[addressKey(url)];
    }
    this.persist();
  }

  forget(url: string) {
    delete this.entries[addressKey(url)];
    this.persist();
  }

  forgetAll() {
    this.entries = {};
    this.persist();
  }

  private persist() {
    if (!this.storage) return;
    const keepToken = this.persistsToken();
    const persisted: Record<string, AddressCredentials> = {};
    for (const [key, { token, mediaToken }] of Object.entries(this.entries)) {
      const entry = {
        ...(keepToken && token ? { token } : {}),
        ...(mediaToken ? { mediaToken } : {})
      };
      if (entry.token || entry.mediaToken) persisted[key] = entry;
    }
    this.storage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(persisted));
  }
}

function parseEntries(stored: string): Record<string, AddressCredentials> {
  const entries: Record<string, AddressCredentials> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return entries;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return entries;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { token, mediaToken } = value as Record<string, unknown>;
    const entry: AddressCredentials = {
      ...(typeof token === "string" && token ? { token } : {}),
      ...(typeof mediaToken === "string" && mediaToken ? { mediaToken } : {})
    };
    if (entry.token || entry.mediaToken) entries[key] = entry;
  }
  return entries;
}

/**
 * The saved addresses worth trying when the active one stops answering: only
 * those the user has signed in at, the original address first. An address
 * without its own sign-in could only be reached by lending it another's.
 */
export function reconnectCandidates(
  activeUrl: string,
  originalUrl: string,
  aliasUrls: string[],
  hasSignIn: (url: string) => boolean
): string[] {
  const seen = new Set([addressKey(activeUrl)]);
  const candidates: string[] = [];
  for (const url of [originalUrl, ...aliasUrls]) {
    const key = addressKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (hasSignIn(url)) candidates.push(url);
  }
  return candidates;
}
