/** The broker accepts an HTTPS origin only, without credentials or a path. */
export function giftBrokerOrigin(value: string): string | null {
  try {
    const input = value.trim();
    const url = new URL(input);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/" || input.includes("?") || input.includes("#")) return null;
    return url.origin;
  } catch {
    return null;
  }
}
/** Require HTTPS for both the page and the actual API URL; never trust a dev proxy's upstream. */
export function giftBrokerTransportSecure(apiBase: string, pageUrl: string, secureContext: boolean, dev: boolean): boolean {
  try {
    const page = new URL(pageUrl);
    const api = new URL(apiBase);
    return secureContext && page.protocol === "https:" && api.protocol === "https:"
      && !(dev && api.origin === page.origin);
  } catch {
    return false;
  }
}
