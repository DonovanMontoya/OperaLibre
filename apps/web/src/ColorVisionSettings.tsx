import { COLOR_VISION_OPTIONS } from "./colorVision";
import type { useDisplaySettings } from "./useDisplaySettings";

export type ColorVisionSettingsProps = Pick<ReturnType<typeof useDisplaySettings>,
  "colorVision" | "strongerVisualCues" | "updateColorVision" | "toggleStrongerVisualCues">;

export function ColorVisionSettings({ colorVision, strongerVisualCues, updateColorVision, toggleStrongerVisualCues }: ColorVisionSettingsProps) {
  return (
    <>
      <div className="settings-toggle-row settings-color-vision-row">
        <label htmlFor="color-vision">
          <strong id="color-vision-label">Color vision</strong>
          <small id="color-vision-help">Choose colors that are easier to distinguish. Covers and illustrations keep their original colors.</small>
        </label>
        <select id="color-vision" value={colorVision} aria-labelledby="color-vision-label" aria-describedby="color-vision-help color-vision-description"
          onChange={(event) => {
            const choice = COLOR_VISION_OPTIONS.find(({ id }) => id === event.currentTarget.value);
            if (choice) updateColorVision(choice.id);
          }}>
          {COLOR_VISION_OPTIONS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
        <small id="color-vision-description">{COLOR_VISION_OPTIONS.find(({ id }) => id === colorVision)?.description}</small>
      </div>
      <div className="settings-toggle-row">
        <span>
          <strong>Stronger visual cues</strong>
          <small>Outlines for selected controls, underlined links, patterned progress, and a numbered listening calendar.</small>
        </span>
        <button type="button" className="settings-switch" role="switch"
          aria-checked={strongerVisualCues} aria-label="Stronger visual cues" onClick={toggleStrongerVisualCues}>
          <span aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
