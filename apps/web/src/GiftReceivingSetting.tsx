import { useState } from "react";
import { deviceGiftReceiving } from "./giftReceiving";

export function GiftReceivingSetting() {
  const [enabled, setEnabled] = useState(() => deviceGiftReceiving.enabled());
  return (
    <div className="settings-toggle-row">
      <span>
        <strong>Receive book gifts</strong>
        <small>Experimental. Opens gift links from people who run their own OperaLibre server. Nothing downloads until you accept a gift. Remembered on this device.</small>
      </span>
      <button
        type="button"
        className="settings-switch"
        role="switch"
        aria-checked={enabled}
        aria-label="Receive book gifts"
        onClick={() => { deviceGiftReceiving.set(!enabled); setEnabled(!enabled); }}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
