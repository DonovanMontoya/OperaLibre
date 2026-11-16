import { ChevronDown } from "lucide-react";

export function BetaFeaturesSettings({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <details className="behavior-settings">
      <summary>
        <span><strong>Beta Features</strong><small>Optional features to try</small></span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="behavior-settings-body">
        <div className="settings-toggle-row">
          <span>
            <strong>Audio clips</strong>
            <small>Save and share private passages. Off by default; remembered on this device. Turning it off keeps saved clips.</small>
          </span>
          <button type="button" className="settings-switch" role="switch" aria-checked={enabled}
            aria-label="Audio clips" onClick={onToggle}>
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
    </details>
  );
}
