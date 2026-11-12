/** Receiving book gifts is experimental and off until this device's owner
 * turns it on, either when the first gift link arrives or in Settings. */
const KEY = "operalibre.giftReceiving.v1";

export type GiftReceivingPreference = { enabled(): boolean; set(enabled: boolean): void };

export const deviceGiftReceiving: GiftReceivingPreference = {
  enabled() {
    try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
  },
  set(enabled) {
    try {
      if (enabled) localStorage.setItem(KEY, "on");
      else localStorage.removeItem(KEY);
    } catch { /* Private storage is unavailable; the choice lasts until the app closes. */ }
  }
};
