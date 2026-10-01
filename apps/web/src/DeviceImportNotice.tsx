import type { DeviceNotice } from "./ConfirmDialogs";

export function DeviceImportNotice({ notice, busy, onRetry }: {
  notice: DeviceNotice | null;
  busy: boolean;
  onRetry: () => Promise<void>;
}) {
  if (notice?.source !== "deviceImport") return null;
  return <div className="empty-state error" role="alert">
    <span>{notice.message}</span>
    <button type="button" className="download-btn" disabled={busy} onClick={() => void onRetry()}>
      Try importing again
    </button>
  </div>;
}
