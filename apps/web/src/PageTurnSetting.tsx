export function PageTurnSetting({ enabled, onToggle }: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="settings-toggle-row">
      <span>
        <strong>Page turn animation</strong>
        <small>Curls the page over like paper when you turn it in the ebook reader. Remembered on this device.</small>
      </span>
      <button
        type="button"
        className="settings-switch"
        role="switch"
        aria-checked={enabled}
        aria-label="Page turn animation"
        onClick={onToggle}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
