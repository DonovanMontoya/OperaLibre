/** Generic owner-hosted landing only. Mount GET /gift after the Worker's
 * experimental gate. Never pass a request, preview, or credentials to this page. */
export const GIFT_INSTALL_DESTINATIONS = Object.freeze({
  // Apple listing identifies Donovan Montoya; beta/release links are in README.
  // No Android Play Store listing has been verified; never invent an ID.
  iphone: "https://apps.apple.com/us/app/operalibre/id6792065037",
  beta: "https://testflight.apple.com/join/x69Ffa33",
  releases: "https://github.com/DonovanMontoya/OperaLibre/releases",
});

export type GiftLandingLinks = { originalUrl: string; nativeUrl: string };

/** Also embedded verbatim in the static client. No fragment leaves this page.
 * Native manifests register this one custom scheme; giftAppLinks.ts validates
 * it before onboarding. No HTTPS association or OS-launch verification implied. */
export function buildGiftLandingLinks(pageUrl: string): GiftLandingLinks | null {
  if (pageUrl.length > 16384 || /[\u0000-\u0020\u007f]/.test(pageUrl)) return null;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/gift") return null;
    const fragment = url.hash.slice(1);
    if (!fragment || fragment.length > 8192 || /[^A-Za-z0-9_%&=.:/-]/.test(fragment) || /%(?![a-fA-F0-9]{2})/.test(fragment)) return null;
    const params = new URLSearchParams(fragment);
    // Validate decoded values without `$`, which accepts a final line break.
    const canonical = (value: string, min: number, max: number) => value.length >= min && value.length <= max && !/[^A-Za-z0-9_-]/.test(value);
    const required = ["gift", "broker", "key", "signing"];
    if ([...params.keys()].some(key => ![...required, "id"].includes(key)) || required.some(key => params.getAll(key).length !== 1) || params.getAll("id").length > 1) return null;
    if (params.has("id") && !canonical(params.get("id")!, 16, 128)) return null;
    if (!canonical(params.get("gift") ?? "", 32, 4096) || !canonical(params.get("key") ?? "", 43, 43) || !canonical(params.get("signing") ?? "", 43, 43)) return null;
    const brokerValue = params.get("broker") ?? "";
    if (/[\u0000-\u0020\u007f]/.test(brokerValue)) return null;
    const broker = new URL(brokerValue);
    if (broker.protocol !== "https:" || broker.username || broker.password || broker.pathname !== "/" || broker.search || broker.hash) return null;
    // Drop any query rather than forwarding it to the app, installs or history.
    // Preserve the validated fragment byte-for-byte; do not re-encode secrets.
    return { originalUrl: `${url.origin}/gift#${fragment}`, nativeUrl: `operalibre://gift#${fragment}` };
  } catch { return null; }
}

function giftLandingClient(buildLinks: typeof buildGiftLandingLinks) {
  const status = document.getElementById("gift-status");
  const original = document.getElementById("original-gift");
  const copy = document.getElementById("copy-gift");
  const open = document.getElementById("open-app");
  let links: GiftLandingLinks | null = null;
  const refresh = () => {
    links = buildLinks(window.location.href);
    original?.removeAttribute("href");
    original?.setAttribute("hidden", "");
    copy?.setAttribute("hidden", "");
    open?.removeAttribute("href");
    open?.setAttribute("hidden", "");
    if (!links) {
      if (status) status.textContent = "This gift link is incomplete or invalid. Ask the sender for the original private link.";
      return;
    }
    if (status) status.textContent = "Your private gift details stay in this link. This page does not request the book or its preview.";
    if (original) {
      original.setAttribute("href", links.originalUrl);
      original.removeAttribute("hidden");
    }
    if (open) {
      open.setAttribute("href", links.nativeUrl);
      open.removeAttribute("hidden");
    }
    if (typeof navigator.clipboard?.writeText === "function") copy?.removeAttribute("hidden");
  };
  refresh();
  window.addEventListener("hashchange", refresh);
  if (copy) {
    copy.addEventListener("click", () => {
      // Revalidate at activation as well, including a just-changed fragment.
      const current = buildLinks(window.location.href);
      if (!current || typeof navigator.clipboard?.writeText !== "function") { refresh(); return; }
      void navigator.clipboard.writeText(current.originalUrl).then(() => {
        if (status && current.originalUrl === links?.originalUrl) status.textContent = "Gift link copied. Keep it private and return to it after installing OperaLibre.";
      }).catch(() => {
        if (status) status.textContent = "Could not copy. Keep this tab open, or return to the original message after installing OperaLibre.";
      });
    });
  }
}

// Pass the helper explicitly: module bundlers may rename exported bindings.
const SCRIPT = `"use strict";\n(${giftLandingClient.toString()})(${buildGiftLandingLinks.toString()});`;
const STYLE = `:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.6}body{margin:0;padding:2rem 1rem}main{max-width:36rem;margin:auto}h1{line-height:1.2}a{color:inherit;text-underline-offset:.2em}a,button{touch-action:manipulation}li{margin:.7rem 0}button{font:inherit;padding:.65rem 1rem;border:1px solid currentColor;border-radius:.5rem;background:transparent;color:inherit}button:disabled{opacity:.7}a:focus-visible,button:focus-visible{outline:3px solid #ad6d23;outline-offset:4px}.gift{font-size:3rem;margin:0}small{display:block}[hidden]{display:none!important}`;

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
<title>A book gift · OperaLibre</title><meta name="description" content="Open a private book gift in OperaLibre.">
<meta property="og:type" content="website"><meta property="og:title" content="A book gift · OperaLibre"><meta property="og:description" content="Open a private book gift in OperaLibre.">
<style>${STYLE}</style></head><body><main>
<p class="gift" aria-hidden="true">🎁</p><h1>A book gift for you</h1>
<p>Use OperaLibre to unwrap your gift. No sender, personal message or book details are shown on this landing page.</p>
<p id="gift-status" role="status" aria-live="polite">Keep this private link so you can return to your gift after installation.</p>
<h2>Already installed?</h2><p><a id="open-app" hidden aria-describedby="open-help" rel="noreferrer" referrerpolicy="no-referrer">Open in OperaLibre</a></p>
<p id="open-help">Tap to ask your browser to open the installed app. Use a trusted OperaLibre build with experimental book gifts enabled; otherwise the app may open without showing the gift. This owner-hosted HTTPS domain is not automatically associated with the app. If opening is unavailable, install a compatible build and return to this private link.</p>
<p>Custom app links are not verified HTTPS links. Another installed app could register the same scheme and receive the private gift link. Continue only if your device opens the trusted OperaLibre app; cancel an unexpected app or chooser.</p>
<h2>Need the app?</h2><ul>
<li><a href="${GIFT_INSTALL_DESTINATIONS.iphone}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">iPhone and iPad: OperaLibre on the App Store</a></li>
<li><a href="${GIFT_INSTALL_DESTINATIONS.beta}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Check iPhone beta availability in TestFlight</a></li>
<li><a href="${GIFT_INSTALL_DESTINATIONS.releases}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Android and other platforms: official releases and available builds</a></li>
</ul><p>The installed build must support book gifts; an install alone does not enable this experimental feature. Current store releases may not support it yet. Android release APKs may be unsigned developer artifacts, not ready-to-install apps. If no compatible build is listed for your platform, ask the sender to wait for one.</p>
<p>After installing, return to the original gift link in Discord or your message. Installation does not automatically restore the gift. Keep this tab open, or copy the link privately.</p>
<p><a id="original-gift" hidden rel="noreferrer" referrerpolicy="no-referrer">Return to your original gift link</a></p>
<button id="copy-gift" type="button" hidden>Copy private gift link</button>
<noscript><p>JavaScript is required to validate the private part of this link. Keep the original message and return to it after installation; the download links above work without JavaScript.</p></noscript>
</main><script>${SCRIPT}</script></body></html>`;

async function cspHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/** No request input by design: queries, paths, headers and crawler user agents
 * cannot cause credential or private-preview reflection in HTML / OpenGraph. */
export async function giftLandingResponse(): Promise<Response> {
  const [scriptHash, styleHash] = await Promise.all([cspHash(SCRIPT), cspHash(STYLE)]);
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "content-security-policy": `default-src 'none'; script-src ${scriptHash}; script-src-attr 'none'; style-src ${styleHash}; style-src-attr 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'; manifest-src 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
  });
}
