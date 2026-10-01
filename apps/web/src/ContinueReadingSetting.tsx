export function ContinueReadingSetting({ enabled, onToggle }: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="settings-toggle-row">
      <span>
        <strong>Play when opening Continue Reading</strong>
        <small>Start playback when you tap a book in Continue Reading. The play button always starts playback. Remembered on this device.</small>
      </span>
      <button
        type="button"
        className="settings-switch"
        role="switch"
        aria-checked={enabled}
        aria-label="Play when opening Continue Reading"
        onClick={onToggle}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
