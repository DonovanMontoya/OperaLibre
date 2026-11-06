/** Public association declarations are an explicit owner setting, not proof
 * that the stock app declares this domain or that a signing identity is owned.
 * Never infer app identifiers, certificate fingerprints or hosts from requests. */
export function giftAssociationResponse(request: Request, raw: string | undefined): Response | null {
  const url = new URL(request.url);
  const apple = url.pathname === "/.well-known/apple-app-site-association";
  const android = url.pathname === "/.well-known/assetlinks.json";
  if (!apple && !android) return null;
  const response = (body: unknown, status: number) => new Response(request.method === "HEAD" ? null : JSON.stringify(body), { status, headers: {
    "content-type": "application/json", "cache-control": status === 200 ? "public, max-age=300" : "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  } });
  if (request.method !== "GET" && request.method !== "HEAD") return response({ error: "Method not allowed." }, 405);
  if (!raw) return response({ error: "App associations are not configured." }, 404);
  try {
    if (raw.length > 8192 || url.protocol !== "https:" || url.search || url.username || url.password) throw new Error();
    const config: unknown = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    const v = config as Record<string, unknown>;
    if (Object.keys(v).some(key => !["origin", "appleAppIds", "androidApps", "matchingAppBuildAcknowledged"].includes(key)) || v.matchingAppBuildAcknowledged !== true
      || typeof v.origin !== "string" || v.origin.length > 512 || /[^\x21-\x7e]/.test(v.origin)) throw new Error();
    const origin = new URL(v.origin);
    if (origin.protocol !== "https:" || origin.origin !== v.origin || origin.port || origin.username || origin.password || origin.hostname.includes("*")
      || !origin.hostname.includes(".") || origin.hostname.endsWith(".") || origin.hostname.startsWith("[") || /^[0-9.]+$/.test(origin.hostname)) throw new Error();
    if (url.origin !== origin.origin) return response({ error: "Association host does not match." }, 404);
    if (!Array.isArray(v.appleAppIds) || v.appleAppIds.length > 4 || !Array.isArray(v.androidApps) || v.androidApps.length > 4) throw new Error();
    const appIds = v.appleAppIds;
    if (appIds.some(id => typeof id !== "string" || id.length > 256 || /[^\x21-\x7e]/.test(id) || !/^[A-Z0-9]{10}\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(id)) || new Set(appIds).size !== appIds.length) throw new Error();
    const packages = new Set<string>();
    const androidApps = v.androidApps.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error();
      const app = item as Record<string, unknown>;
      if (Object.keys(app).some(key => !["packageName", "sha256Fingerprints"].includes(key)) || typeof app.packageName !== "string" || app.packageName.length > 256
        || /[^\x21-\x7e]/.test(app.packageName) || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(app.packageName) || packages.has(app.packageName)
        || !Array.isArray(app.sha256Fingerprints) || !app.sha256Fingerprints.length || app.sha256Fingerprints.length > 4
        || app.sha256Fingerprints.some(value => typeof value !== "string" || /[^0-9A-F:]/.test(value) || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))
        || new Set(app.sha256Fingerprints).size !== app.sha256Fingerprints.length) throw new Error();
      packages.add(app.packageName);
      return { relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: app.packageName, sha256_cert_fingerprints: app.sha256Fingerprints } };
    });
    if (!appIds.length && !androidApps.length) throw new Error();
    if (apple && !appIds.length || android && !androidApps.length) return response({ error: "Platform association is not configured." }, 404);
    // Apple restricts this declaration to /gift. Android verification delegates
    // the host; the matching manifest MUST independently restrict /gift.
    return response(apple ? { applinks: { details: [{ appIDs: appIds, components: [{ "/": "/gift" }] }] } } : androidApps, 200);
  } catch { return response({ error: "App association configuration is invalid." }, 503); }
}
