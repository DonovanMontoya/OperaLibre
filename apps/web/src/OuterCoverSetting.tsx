import { Capacitor, registerPlugin } from "@capacitor/core";
import { useEffect, useState } from "react";
import { useDeviceFold } from "./deviceFold";

type OuterCoverState = { supported: boolean; enabled: boolean; camera: "granted" | "prompt" | "denied" };

interface OuterCoverPlugin {
  getState(): Promise<OuterCoverState>;
  setEnabled(options: { enabled: boolean }): Promise<OuterCoverState>;
}
const OuterCover = registerPlugin<OuterCoverPlugin>("OuterCover");

/**
 * iPhone Duo only: the loaded book's cover on the outer screen while the phone
 * is open. iOS lends that screen only to a running camera preview, so the
 * description says so plainly. The setting lives in the native app.
 */
export function OuterCoverSetting() {
  const fold = useDeviceFold();
  const [state, setState] = useState<OuterCoverState | null>(null);
  const [busy, setBusy] = useState(false);
  const available = Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("OuterCover");

  useEffect(() => {
    if (!available) return;
    void OuterCover.getState().then(setState).catch(() => undefined);
  }, [available]);

  // A hinge reports a posture; every other phone stays "unknown".
  if (!state?.supported || fold.posture === "unknown") return null;

  const toggle = () => {
    setBusy(true);
    void OuterCover.setEnabled({ enabled: !state.enabled })
      .then(setState)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <div className="settings-toggle-row">
      <span>
        <strong>Cover on outer screen</strong>
        <small>
          While the phone is open, shows the book’s cover on the outer screen. iOS allows this only alongside a
          camera preview, so the rear camera runs at low quality behind a small viewfinder. Nothing is recorded or
          saved, and it uses more battery.
          {state.camera === "denied" ? " Allow camera access for OperaLibre in the Settings app to use this." : ""}
        </small>
      </span>
      <button
        type="button"
        className="settings-switch"
        role="switch"
        aria-checked={state.enabled}
        aria-label="Cover on outer screen"
        disabled={busy || state.camera === "denied"}
        onClick={toggle}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
