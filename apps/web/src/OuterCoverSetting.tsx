import { Capacitor, registerPlugin } from "@capacitor/core";
import { Camera, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useDeviceFold } from "./deviceFold";
import { useModalFocus } from "./useModalFocus";

type OuterCoverState = { supported: boolean; enabled: boolean; camera: "granted" | "prompt" | "denied" };

interface OuterCoverPlugin {
  getState(): Promise<OuterCoverState>;
  setEnabled(options: { enabled: boolean }): Promise<OuterCoverState>;
}
const OuterCover = registerPlugin<OuterCoverPlugin>("OuterCover");

/**
 * iPhone Duo only: the loaded book's cover on the outer screen while the phone
 * is open. iOS lends that screen only to a running camera preview, so it is off
 * by default and turning it on first explains what that means. The setting
 * lives in the native app.
 */
export function OuterCoverSetting() {
  const fold = useDeviceFold();
  const [state, setState] = useState<OuterCoverState | null>(null);
  const [busy, setBusy] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const available = Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("OuterCover");

  useEffect(() => {
    if (!available) return;
    void OuterCover.getState().then(setState).catch(() => undefined);
  }, [available]);

  // A hinge reports a posture; every other phone stays "unknown".
  if (!state?.supported || fold.posture === "unknown") return null;

  const setEnabled = (enabled: boolean) => {
    setBusy(true);
    void OuterCover.setEnabled({ enabled })
      .then(setState)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <div className="settings-toggle-row">
      <span>
        <strong>Cover on outer screen</strong>
        <small>
          While the phone is open, shows the book’s cover on the outer screen. Uses the camera and more battery.
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
        onClick={() => (state.enabled ? setEnabled(false) : setExplaining(true))}
      >
        <span aria-hidden="true" />
      </button>
      {explaining ? (
        <OuterCoverExplainer
          askForCamera={state.camera === "prompt"}
          onCancel={() => setExplaining(false)}
          onConfirm={() => {
            setExplaining(false);
            setEnabled(true);
          }}
        />
      ) : null}
    </div>
  );
}

function OuterCoverExplainer({ askForCamera, onCancel, onConfirm }: {
  askForCamera: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useModalFocus<HTMLElement>(onCancel);
  return createPortal(
    <div className="modal-scrim unplayed-confirm-scrim" role="presentation">
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="modal-card unplayed-confirm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="outer-cover-title"
        aria-describedby="outer-cover-description"
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow"><Camera size={13} /> iPhone Duo</span>
            <h2 id="outer-cover-title">Show the cover on the outer screen?</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Cancel" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <div id="outer-cover-description" className="unplayed-confirm-copy outer-cover-copy">
          <p>
            While the phone is open, the outer screen can show the cover of the book you’re listening to, for
            whoever is across from you.
          </p>
          <p>
            iOS only lets apps use the outer screen alongside a camera preview. So while the cover is up, the rear
            camera runs at low quality behind a small viewfinder in the corner, and the green camera indicator stays
            on. Nothing is recorded, saved, or sent anywhere.
          </p>
          <p>
            It runs only while the phone is open and OperaLibre is on screen, and it uses more battery. You can turn it
            off here at any time.
            {askForCamera ? " iOS will ask for camera access next." : ""}
          </p>
        </div>
        <div className="unplayed-confirm-actions">
          <button type="button" className="unplayed-confirm-cancel" data-modal-initial-focus onClick={onCancel}>
            Not now
          </button>
          <button type="button" className="unplayed-confirm-submit" onClick={onConfirm}>
            <Camera size={15} /> Turn on
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
