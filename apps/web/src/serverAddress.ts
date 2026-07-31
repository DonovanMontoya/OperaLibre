const PRIVATE_HOST_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa", ".localhost", ".ts.net"];

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    // RFC 6598 shared address space is used by private overlay networks such
    // as Tailscale. It is not globally routable despite not being RFC 1918.
    || (first === 100 && second >= 64 && second <= 127);
}

export function isPrivateServerHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname) return false;
  if (hostname === "localhost" || (!hostname.includes(".") && !hostname.includes(":"))) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;

  const ipv4 = parseIpv4(hostname);
  if (ipv4) return isPrivateIpv4(ipv4);

  const mappedIpv4 = hostname.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedIpv4) {
    const mapped = parseIpv4(mappedIpv4[1]);
    return mapped ? isPrivateIpv4(mapped) : false;
  }

  // IPv6 loopback, unique-local (fc00::/7), and link-local (fe80::/10).
  return hostname === "::1"
    || hostname === "::"
    || /^(?:fc|fd)[0-9a-f]{2}:/i.test(hostname)
    || /^fe[89ab][0-9a-f]:/i.test(hostname);
}

export function normalizeServerAddress(rawValue: string): string {
  let value = rawValue.trim();
  if (!value) return "";

  const hasScheme = /^https?:\/\//i.test(value);
  if (!hasScheme) {
    let parsedForHost: URL;
    try {
      parsedForHost = new URL(`http://${value}`);
    } catch {
      return value.replace(/\/+$/, "");
    }
    const scheme = isPrivateServerHostname(parsedForHost.hostname) ? "http" : "https";
    value = `${scheme}://${value}`;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return value.replace(/\/+$/, "");
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

export function requireSecurePublicServerAddress(rawValue: string): string {
  const normalized = normalizeServerAddress(rawValue);
  if (!normalized) return normalized;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return normalized;
  }
  if (parsed.protocol === "http:" && !isPrivateServerHostname(parsed.hostname)) {
    throw new Error(
      "Public server addresses must use HTTPS. Use https://, or use a private LAN address for an HTTP server."
    );
  }
  return normalized;
}

export function upgradeStoredNativeServerAddress(rawValue: string): string {
  const normalized = normalizeServerAddress(rawValue);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "http:" && !isPrivateServerHostname(parsed.hostname)) {
      parsed.protocol = "https:";
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    // Leave malformed legacy values unchanged so the connection screen can
    // show them and let the user correct the address.
  }
  return normalized;
}
