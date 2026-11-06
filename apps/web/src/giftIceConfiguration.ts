/** Parse only the sender-signed, encrypted per-invitation ICE projection. No
 * provider API token or TURN REST master secret is a permitted preview field. */
export function parseGiftIceConfiguration(value: unknown, giftId: string, expiresAt: number): RTCConfiguration | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => { throw new Error("Invalid gift connectivity."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["giftId", "expiresAt", "iceServers", "iceTransportPolicy"].includes(key))
    || record.giftId !== giftId || record.expiresAt !== expiresAt || !Array.isArray(record.iceServers) || record.iceServers.length > 4
    || typeof record.iceTransportPolicy !== "string" || !["all", "relay"].includes(record.iceTransportPolicy)) return fail();
  const seen = new Set<string>(); let hasTurn = false;
  const iceServers: RTCIceServer[] = record.iceServers.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some(key => !["urls", "username", "credential"].includes(key)) || !Array.isArray(entry.urls) || !entry.urls.length || entry.urls.length > 4) return fail();
    let kind: string | undefined;
    const urls = entry.urls.map((url: unknown) => {
      if (typeof url !== "string" || url.length > 512 || /[^\x21-\x7e]|[@#/%\\]/.test(url) || seen.has(url) || seen.size >= 8) return fail();
      const match = /^(stun|turn):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(\?transport=udp)?$/.exec(url);
      if (!match || match[0] !== url || (match[3] && (+match[3] < 1 || +match[3] > 65535)) || (match[1] === "stun" && match[4]) || (kind && kind !== match[1])) return fail();
      if (match[2].startsWith("[")) {
        try { new URL(`http://${match[2]}`); } catch { return fail(); }
      } else if (match[2].length > 253 || match[2].replace(/\.$/, "").split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return fail();
      kind = match[1]; seen.add(url); return url;
    });
    if (kind === "turn") {
      hasTurn = true;
      const username = entry.username, credential = entry.credential;
      if (typeof username !== "string" || username.length > 256 || !username.startsWith(`${expiresAt}:operalibre:${giftId}:recipient:`)
        || /[^\x21-\x7e]/.test(username) || typeof credential !== "string" || !/^[A-Za-z0-9+/]{27}=$/.test(credential)) return fail();
      return { urls, username, credential };
    }
    if (entry.username !== undefined || entry.credential !== undefined) return fail();
    return { urls };
  });
  if (record.iceTransportPolicy === "relay" && !hasTurn) return fail();
  return { iceServers, iceTransportPolicy: record.iceTransportPolicy as RTCIceTransportPolicy };
}
