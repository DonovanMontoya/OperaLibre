export function ClippingSetting({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <div className="settings-toggle-row">
      <span>
        <strong>Audio clips</strong>
        <small>Show the save ribbon and Clips tab. Saved passages are kept when turned off.</small>
      </span>
      <button type="button" className="settings-switch" role="switch" aria-checked={enabled}
        aria-label="Audio clips" onClick={onToggle}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
