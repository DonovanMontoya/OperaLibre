import { Minus, Plus } from "lucide-react";
import { useRef, useState } from "react";
import {
  formatPlaybackSpeed,
  normalizePlaybackSpeed,
  PLAYBACK_SPEED_MAX,
  PLAYBACK_SPEED_MIN,
  PLAYBACK_SPEED_PRESETS,
  PLAYBACK_SPEED_STEP,
  PLAYBACK_SPEED_VALUES
} from "./playbackSpeed";
import {
  BOOK_GAIN_DB_MAX,
  BOOK_GAIN_DB_MIN,
  BOOK_GAIN_DB_PRESETS,
  BOOK_GAIN_DB_STEP,
  bookGainToDb,
  formatBookGainDb
} from "./bookVolume";
import { haptic, selectionHaptic } from "./native";

const SPEED_WHEEL_SPACING_PX = 48;

/**
 * A book's own loudness trim. Audiobooks are mastered at wildly different
 * levels, and the device volume is the wrong knob for that: turning it up for
 * one quiet narrator leaves it far too loud for the next book.
 *
 * The scale is decibels because that is the unit loudness moves in — equal
 * steps sound equally large, which a linear multiplier does not.
 */
export function BookVolumeControl({
  value,
  onChange,
  canBoost,
  inputId,
  compact = false
}: {
  value: number;
  onChange: (db: number) => void;
  canBoost: boolean;
  inputId: string;
  /**
   * The desktop card sits in a row of restrained controls — a bare slider, a
   * select — so it stays a bare slider with a value under it. The full form,
   * with its heading and tap-sized presets, is for the phone sheet.
   */
  compact?: boolean;
}) {
  const db = bookGainToDb(value);
  const maximum = canBoost ? BOOK_GAIN_DB_MAX : 0;
  const position = Math.min(db, maximum);
  const presetOptions = BOOK_GAIN_DB_PRESETS.filter((preset) => preset <= maximum);
  const sliderDragging = useRef(false);

  // The same tactile grammar as the speed wheel beside it: a drag ticks once
  // per decibel step, a discrete nudge (stepper button, arrow key) bumps.
  function change(next: number, source: "drag" | "step") {
    const bounded = Math.min(maximum, Math.max(BOOK_GAIN_DB_MIN, next));
    if (bounded === position) return;
    if (source === "drag") selectionHaptic("change");
    else haptic("light");
    onChange(bounded);
  }

  const slider = (
    <input
      id={inputId}
      type="range"
      min={BOOK_GAIN_DB_MIN}
      max={maximum}
      step={BOOK_GAIN_DB_STEP}
      value={position}
      aria-valuetext={formatBookGainDb(position)}
      onPointerDown={() => {
        sliderDragging.current = true;
        selectionHaptic("start");
      }}
      onPointerUp={() => {
        sliderDragging.current = false;
        selectionHaptic("end");
      }}
      onPointerCancel={() => {
        sliderDragging.current = false;
        selectionHaptic("end");
      }}
      onChange={(event) => change(Number(event.currentTarget.value), sliderDragging.current ? "drag" : "step")}
    />
  );

  const hint = canBoost ? null : (
    <span className="book-volume-hint">
      This page can only quiet a book. Lifting one needs the phone or desktop app, or a frontend
      served by OperaLibre itself.
    </span>
  );

  if (compact) {
    // Label, control, one line of state — the shape the Nightfall card beside
    // it already uses.
    return (
      <div className="book-volume book-volume-compact">
        {slider}
        <span className="book-volume-value">{formatBookGainDb(db)}</span>
        {hint}
      </div>
    );
  }

  // Laid out like the cadence control it sits beside: the value reads above the
  // track, the ends of the range label themselves, and the presets close the
  // card.
  return (
    <div className="book-volume book-volume-full">
      <div className="book-volume-heading">
        <output aria-live="polite">{formatBookGainDb(db)}</output>
        <span>{BOOK_GAIN_DB_STEP} dB steps</span>
      </div>
      <div className="book-volume-slider-row">
        <button
          type="button"
          aria-label={`Decrease amplification by ${BOOK_GAIN_DB_STEP} decibel`}
          disabled={position <= BOOK_GAIN_DB_MIN}
          onClick={() => change(position - BOOK_GAIN_DB_STEP, "step")}
        >
          <Minus size={17} />
        </button>
        {slider}
        <button
          type="button"
          aria-label={`Increase amplification by ${BOOK_GAIN_DB_STEP} decibel`}
          disabled={position >= maximum}
          onClick={() => change(position + BOOK_GAIN_DB_STEP, "step")}
        >
          <Plus size={17} />
        </button>
      </div>
      <div className="book-volume-range-labels" aria-hidden="true">
        <span>{formatBookGainDb(BOOK_GAIN_DB_MIN)}</span>
        <span>{maximum === 0 ? "Original" : `+${maximum} dB`}</span>
      </div>
      {/* A lone "back to normal" pill is not a choice, so the row only earns
          its space where there is something to choose between. */}
      {presetOptions.length > 1 ? (
        <div className="book-volume-presets">
          {presetOptions.map((preset) => (
            <button
              key={preset}
              type="button"
              className={preset === position ? "selected" : ""}
              aria-label={preset === 0 ? "Original level" : `Plus ${preset} decibels`}
              onClick={() => {
                if (preset !== position) haptic("light");
                onChange(preset);
              }}
            >
              {preset === 0 ? "0" : `+${preset}`}
            </button>
          ))}
        </div>
      ) : null}
      {hint}
    </div>
  );
}

export function PlaybackSpeedControl({
  value,
  onChange,
  rotary = false
}: {
  value: number;
  onChange: (value: number) => void;
  rotary?: boolean;
}) {
  const formattedSpeed = formatPlaybackSpeed(value);
  const currentIndex = PLAYBACK_SPEED_VALUES.indexOf(normalizePlaybackSpeed(value));
  const [wheelDragIndex, setWheelDragIndex] = useState<number | null>(null);
  const visualWheelIndex = wheelDragIndex ?? currentIndex;
  const atMinimum = value <= PLAYBACK_SPEED_MIN;
  const atMaximum = value >= PLAYBACK_SPEED_MAX;
  const dragState = useRef<{
    lastIndex: number;
    pointerId: number;
    startIndex: number;
    startX: number;
  } | null>(null);

  function selectIndex(index: number, withHaptic = false) {
    const nextIndex = Math.min(PLAYBACK_SPEED_VALUES.length - 1, Math.max(0, index));
    const nextValue = PLAYBACK_SPEED_VALUES[nextIndex];
    if (nextValue === value) return;
    if (withHaptic) haptic("light");
    onChange(nextValue);
  }

  return (
    <div className="speed-control">
      {rotary ? (
        <>
          <div className="speed-wheel-shell">
            <button
              type="button"
              aria-label={`Decrease playback speed by ${PLAYBACK_SPEED_STEP} times`}
              disabled={atMinimum}
              onClick={() => selectIndex(currentIndex - 1, true)}
            >
              <Minus size={17} />
            </button>
            <div
              className={`speed-wheel${wheelDragIndex === null ? "" : " dragging"}`}
              role="slider"
              tabIndex={0}
              aria-label="Playback speed"
              aria-orientation="horizontal"
              aria-valuemin={PLAYBACK_SPEED_MIN}
              aria-valuemax={PLAYBACK_SPEED_MAX}
              aria-valuenow={value}
              aria-valuetext={`${formattedSpeed} times${value === 1 ? ", normal" : ""}`}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                  event.preventDefault();
                  selectIndex(currentIndex - 1, true);
                } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                  event.preventDefault();
                  selectIndex(currentIndex + 1, true);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  selectIndex(0, true);
                } else if (event.key === "End") {
                  event.preventDefault();
                  selectIndex(PLAYBACK_SPEED_VALUES.length - 1, true);
                }
              }}
              onPointerDown={(event) => {
                dragState.current = {
                  lastIndex: currentIndex,
                  pointerId: event.pointerId,
                  startIndex: currentIndex,
                  startX: event.clientX
                };
                setWheelDragIndex(currentIndex);
                selectionHaptic("start");
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragState.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                const dragIndex = Math.min(
                  PLAYBACK_SPEED_VALUES.length - 1,
                  Math.max(0, drag.startIndex + (drag.startX - event.clientX) / SPEED_WHEEL_SPACING_PX)
                );
                setWheelDragIndex(dragIndex);
                const nextIndex = Math.round(dragIndex);
                if (nextIndex === drag.lastIndex) return;
                drag.lastIndex = nextIndex;
                selectionHaptic("change");
                selectIndex(nextIndex);
              }}
              onPointerUp={(event) => {
                if (dragState.current?.pointerId !== event.pointerId) return;
                dragState.current = null;
                setWheelDragIndex(null);
                selectionHaptic("end");
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                dragState.current = null;
                setWheelDragIndex(null);
                selectionHaptic("end");
              }}
              onWheel={(event) => {
                if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
                event.preventDefault();
                selectIndex(currentIndex + (event.deltaX > 0 ? 1 : -1), true);
              }}
            >
              <div className="speed-wheel-lens" aria-hidden="true" />
              <div className="speed-wheel-pointer" aria-hidden="true" />
              {PLAYBACK_SPEED_VALUES.map((option, index) => {
                const offset = index - visualWheelIndex;
                if (Math.abs(offset) > 3.5) return null;
                const distance = Math.min(3, Math.round(Math.abs(offset)));
                return (
                  <span
                    key={option}
                    className={`speed-wheel-value distance-${distance}${index === currentIndex ? " selected" : ""}`}
                    style={{
                      "--speed-x": `${offset * SPEED_WHEEL_SPACING_PX}px`,
                      "--speed-turn": `${offset * -32}deg`
                    } as React.CSSProperties}
                    aria-hidden="true"
                  >
                    {formatPlaybackSpeed(option)}
                  </span>
                );
              })}
            </div>
            <button
              type="button"
              aria-label={`Increase playback speed by ${PLAYBACK_SPEED_STEP} times`}
              disabled={atMaximum}
              onClick={() => selectIndex(currentIndex + 1, true)}
            >
              <Plus size={17} />
            </button>
          </div>
          <p className="speed-wheel-hint">
            <span>Swipe to rotate</span>
            <span>{formattedSpeed}× · {PLAYBACK_SPEED_STEP}× steps</span>
          </p>
        </>
      ) : (
        <>
          <div className="speed-slider-heading">
            <output aria-live="polite">{formattedSpeed}×</output>
            <span>{PLAYBACK_SPEED_STEP}× steps</span>
          </div>
          <input
            type="range"
            min={PLAYBACK_SPEED_MIN}
            max={PLAYBACK_SPEED_MAX}
            step={PLAYBACK_SPEED_STEP}
            value={value}
            aria-label="Playback speed"
            aria-valuetext={`${formattedSpeed} times${value === 1 ? ", normal" : ""}`}
            onChange={(event) => onChange(normalizePlaybackSpeed(Number(event.currentTarget.value)))}
          />
          <div className="speed-range-labels" aria-hidden="true">
            <span>{PLAYBACK_SPEED_MIN}×</span>
            <span>{PLAYBACK_SPEED_MAX}×</span>
          </div>
        </>
      )}
      <div className="speed-presets" aria-label="Playback speed presets">
        {PLAYBACK_SPEED_PRESETS.map((option) => (
          <button
            type="button"
            key={option}
            className={value === option ? "selected" : ""}
            aria-pressed={value === option}
            onClick={() => {
              if (rotary && value !== option) haptic("light");
              onChange(option);
            }}
          >
            {formatPlaybackSpeed(option)}×
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Range input that only commits the seek when the interaction ends, so
 * brushing against the bar can't silently move playback — a stray touch can
 * be dragged back to where it started before letting go.
 */
export function ScrubSlider({
  ariaLabel,
  max,
  value,
  onCommit,
  onPreview
}: {
  ariaLabel: string;
  max: number;
  value: number;
  onCommit: (value: number) => void;
  onPreview?: (value: number | null) => void;
}) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const displayedValue = dragValue ?? value;
  const progressPercent = max > 0
    ? Math.min(100, Math.max(0, (displayedValue / max) * 100))
    : 0;
  const commit = () => {
    if (pendingRef.current !== null) {
      onCommit(pendingRef.current);
      pendingRef.current = null;
    }
    setDragValue(null);
    onPreview?.(null);
  };
  const cancel = () => {
    pendingRef.current = null;
    setDragValue(null);
    onPreview?.(null);
  };
  return (
    <input
      aria-label={ariaLabel}
      type="range"
      min="0"
      max={max}
      step="1"
      value={displayedValue}
      style={{ "--scrub-progress": `${progressPercent}%` } as React.CSSProperties}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        pendingRef.current = next;
        setDragValue(next);
        onPreview?.(next);
      }}
      onPointerUp={commit}
      onPointerCancel={cancel}
      onTouchEnd={commit}
      onTouchCancel={cancel}
      onKeyUp={commit}
      onBlur={commit}
    />
  );
}
