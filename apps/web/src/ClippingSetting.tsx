export function ClippingSetting({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <div className="settings-toggle-row">
      <span>
        <strong>Show audio clips</strong>
        <small>Show the gold ribbon on the cover and each book’s Clips tab. Clips you saved are kept when this is off. Remembered on this device.</small>
      </span>
      <button type="button" className="settings-switch" role="switch" aria-checked={enabled}
        aria-label="Show audio clips" onClick={onToggle}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
