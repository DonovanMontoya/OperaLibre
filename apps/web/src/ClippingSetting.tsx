export function ClippingSetting({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <div className="settings-toggle-row">
      <span>
        <strong>Audio clips</strong>
        <small>Show the gold ribbon that saves a clip while you listen, and each book’s clips. Turning this off keeps the clips you saved. Remembered on this device.</small>
      </span>
      <button type="button" className="settings-switch" role="switch" aria-checked={enabled}
        aria-label="Audio clips" onClick={onToggle}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
