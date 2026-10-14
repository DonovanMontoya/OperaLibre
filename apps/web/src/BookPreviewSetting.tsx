export function BookPreviewSetting({ enabled, onToggle }: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="settings-toggle-row">
      <span>
        <strong>Audio previews</strong>
        <small>Show a Preview bar beneath a book’s cover that plays its opening minutes. Remembered on this device.</small>
      </span>
      <button
        type="button"
        className="settings-switch"
        role="switch"
        aria-checked={enabled}
        aria-label="Audio previews"
        onClick={onToggle}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
