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
    if (status) status.textContent = "This page never sees the book or who sent it. Those details stay inside your private link.";
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
const STYLE = `:root{color-scheme:light dark;--paper:#f1e7d0;--ink:#1a1410;--faded:#6b5a4c;--accent:#8b2e1f;--on-accent:#f1e7d0;--line:rgba(26,20,16,.16)}@media (prefers-color-scheme:dark){:root{--paper:#17120f;--ink:#efe4cf;--faded:#b3a48f;--accent:#c9684f;--on-accent:#17120f;--line:rgba(239,228,207,.2)}}body{margin:0;padding:3rem 1.25rem;background:var(--paper);color:var(--ink);font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;line-height:1.55}main{max-width:30rem;margin:auto}h1{margin:1.5rem 0 .5rem;font-size:2rem;line-height:1.15}h2{margin:2.5rem 0 .5rem;font-size:1.1rem}p{margin:.75rem 0}a{color:inherit;text-underline-offset:.2em}a,button{touch-action:manipulation}ul{padding-left:1.2rem}li{margin:.6rem 0}.parcel{width:4.5rem;height:6.75rem;border-radius:3px 5px 5px 3px;background:linear-gradient(transparent 58%,#a97b2f 58%,#d9b574 60%,#d9b574 67%,#a97b2f 69%,transparent 69%),linear-gradient(90deg,transparent 44%,#a97b2f 44%,#d9b574 47%,#d9b574 53%,#a97b2f 56%,transparent 56%),#6e2418;box-shadow:0 1rem 2rem -.75rem rgba(40,14,8,.5)}#open-app{display:block;margin:1.5rem 0 .5rem;padding:.95rem 1.25rem;border-radius:14px;background:var(--accent);color:var(--on-accent);font-weight:600;font-size:1.05rem;text-align:center;text-decoration:none}button{font:inherit;padding:.7rem 1rem;border:1px solid var(--line);border-radius:12px;background:transparent;color:inherit}.quiet,#open-help{color:var(--faded);font-size:.9rem}.note{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line)}a:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:4px}[hidden]{display:none!important}`;

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
<title>A book gift · OperaLibre</title><meta name="description" content="Open a private book gift in OperaLibre.">
<meta property="og:type" content="website"><meta property="og:title" content="A book gift · OperaLibre"><meta property="og:description" content="Open a private book gift in OperaLibre.">
<style>${STYLE}</style></head><body><main>
<div class="parcel" aria-hidden="true"></div><h1>Someone sent you a book</h1>
<p>Open it in the OperaLibre app to see who it is from and unwrap it. You do not need an account.</p>
<p><a id="open-app" hidden aria-describedby="open-help" rel="noreferrer" referrerpolicy="no-referrer">Open in OperaLibre</a></p>
<p id="open-help">Book gifts are experimental, so the app asks before it opens your first one.</p>
<p id="gift-status" class="quiet" role="status" aria-live="polite">Keep this private link so you can return to your gift after installation.</p>
<h2>Need the app?</h2><ul>
<li><a href="${GIFT_INSTALL_DESTINATIONS.iphone}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">iPhone and iPad: OperaLibre on the App Store</a></li>
<li><a href="${GIFT_INSTALL_DESTINATIONS.beta}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Newer iPhone builds in TestFlight</a></li>
<li><a href="${GIFT_INSTALL_DESTINATIONS.releases}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Android and other platforms: official releases</a></li>
</ul>
<p class="quiet">Gifts need a recent build, and they expire quickly. Installation does not automatically restore the gift: come back to this link afterwards, or copy it now.</p>
<p><a id="original-gift" hidden rel="noreferrer" referrerpolicy="no-referrer">Return to your original gift link</a></p>
<button id="copy-gift" type="button" hidden>Copy private gift link</button>
<p class="quiet note">Custom app links are not verified HTTPS links. Another installed app could register the same scheme and receive this private link. Continue only if your device opens OperaLibre, and cancel an unexpected app or chooser.</p>
<noscript><p>JavaScript is required to check the private part of this link. Keep the original message and return to it after installation; the download links above work without JavaScript.</p></noscript>
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
