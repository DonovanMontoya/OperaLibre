import { Check, ChevronLeft, ChevronDown, ChevronRight, CornerDownRight, LoaderCircle, Minus, Play, Plus, Scissors, Share2, Square, Trash2, X } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { type ChapterSegment, chapterAtBookPosition } from "./chapters";
import {
  CLIP_LEAD_SECONDS,
  CLIP_MAX_SECONDS,
  CLIP_TAIL_SECONDS,
  type Clip,
  type ClipRange,
  clipLengthLabel,
  clipName,
  clipSpan,
  resizeClip,
  slideClip
} from "./clips";
import { formatTime } from "./formatting";
import { haptic, selectionHaptic } from "./native";
import type { useClips } from "./useClips";
import { useModalFocus } from "./useModalFocus";
import type { Book } from "./types";

/** The share of the dial the clip fills. The rest shows what comes before and after it. */
const DIAL_FRAME = 0.6;
/** Seconds per bar, coarser for longer clips so the frame never holds more than a phone can draw apart. */
const DIAL_BAR_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const DIAL_FRAME_BARS = 44;
/** A drag shorter than this is a tap, which leaves the clip where it is. */
const DIAL_DRAG_SLOP = 3;

/** Lengths offered in the picker: every second up to a minute, every five after. */
const CLIP_LENGTHS = Array.from({ length: CLIP_MAX_SECONDS }, (_, index) => index + 1)
  .filter((seconds) => seconds <= 60 || seconds % 5 === 0);

/**
 * The strip is a time ruler, not a waveform: the server has no loudness data,
 * and invented peaks would suggest speech and silence that are not there.
 * Every fifth tick is tall and every twentieth carries its time.
 */
const DIAL_MAJOR_TICK = 5;
const DIAL_LABELLED_TICK = 20;
const FRAME_START = (1 - DIAL_FRAME) / 2;
const FRAME_END = 1 - FRAME_START;

/**
 * Choosing the passage the way a story picks its music: the frame stays put
 * and the audio is dragged beneath it. Length is a separate control.
 */
function ClipDial({
  bookDuration,
  onChange,
  onSettle,
  playhead,
  range
}: {
  bookDuration: number;
  onChange: (range: ClipRange) => void;
  /** The listener let go of the audio; the range is where it came to rest. */
  onSettle: (range: ClipRange) => void;
  /** Where playback is, while this clip is the one playing. */
  playhead: number | null;
  range: ClipRange;
}) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    startSeconds: number;
    secondsPerPixel: number;
    moved: boolean;
    range: ClipRange;
  } | null>(null);

  const length = range.endSeconds - range.startSeconds;
  const span = length / DIAL_FRAME;
  const viewStart = range.startSeconds - (span - length) / 2;
  const step = DIAL_BAR_STEPS.find((candidate) => length / candidate <= DIAL_FRAME_BARS) ?? 10;
  const lastSecond = Math.min(viewStart + span, bookDuration > 0 ? bookDuration : Infinity);
  const bars: number[] = [];
  for (let index = Math.max(0, Math.floor(viewStart / step)); index * step < lastSecond; index += 1) bars.push(index);

  function move(next: ClipRange) {
    if (Math.floor(next.startSeconds / step) !== Math.floor(range.startSeconds / step)) selectionHaptic("change");
    onChange(next);
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || dragRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      startSeconds: range.startSeconds,
      secondsPerPixel: span / event.currentTarget.getBoundingClientRect().width,
      moved: false,
      range
    };
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    const current = dragRef.current;
    if (current?.pointerId !== event.pointerId) return;
    const travelled = event.clientX - current.x;
    if (!current.moved) {
      if (Math.abs(travelled) < DIAL_DRAG_SLOP) return;
      current.moved = true;
      setDragging(true);
      selectionHaptic("start");
    }
    // The audio follows the finger, so pulling it left brings later audio under the frame.
    current.range = slideClip(range, current.startSeconds - travelled * current.secondsPerPixel, bookDuration);
    move(current.range);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>, settled: boolean) {
    const current = dragRef.current;
    if (current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!current.moved) return;
    setDragging(false);
    selectionHaptic("end");
    if (settled) onSettle(current.range);
  }

  function nudge(event: KeyboardEvent<HTMLDivElement>) {
    const seconds = {
      ArrowLeft: -1,
      ArrowDown: -1,
      ArrowRight: 1,
      ArrowUp: 1,
      PageDown: -10,
      PageUp: 10
    }[event.key];
    if (!seconds) return;
    event.preventDefault();
    const next = slideClip(range, range.startSeconds + seconds, bookDuration);
    move(next);
    onSettle(next);
  }

  return (
    <div className="clip-dial-block">
      <div
        className={`clip-dial${dragging ? " dragging" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label="Where the clip starts"
        aria-valuemin={0}
        aria-valuemax={bookDuration > 0 ? Math.max(0, bookDuration - length) : Math.max(range.startSeconds, 86400)}
        aria-valuenow={range.startSeconds}
        aria-valuetext={`${formatTime(range.startSeconds)} to ${formatTime(range.endSeconds)}`}
        style={{ "--clip-dial-pitch": `${(step / span) * 100}%` } as CSSProperties}
        onPointerDown={beginDrag}
        onPointerMove={drag}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        onLostPointerCapture={(event) => endDrag(event, false)}
        onKeyDown={nudge}
      >
        <div className="clip-dial-audio" aria-hidden="true">
          {bars.map((index) => {
            const second = index * step;
            const inside = second >= range.startSeconds && second < range.endSeconds;
            const left = `${((second - viewStart) / span) * 100}%`;
            return (
              <i
                key={index}
                className={[
                  inside ? (playhead !== null && second < playhead ? "played" : "kept") : "",
                  index % DIAL_MAJOR_TICK === 0 ? "major" : ""
                ].join(" ").trim() || undefined}
                style={{ left }}
              />
            );
          })}
          {bars.map((index) => ({ index, at: (index * step - viewStart) / span }))
            // The frame's edges already carry their times below the dial.
            .filter(({ index, at }) => index % DIAL_LABELLED_TICK === 0 && Math.abs(at - FRAME_START) > 0.07 && Math.abs(at - FRAME_END) > 0.07)
            .map(({ index, at }) => (
              <b key={`label-${index}`} style={{ left: `${at * 100}%` }}>{formatTime(index * step)}</b>
            ))}
        </div>
        {viewStart < 0 ? (
          <div className="clip-dial-edge" style={{ left: `${(-viewStart / span) * 100}%` }} aria-hidden="true"><span>Start</span></div>
        ) : null}
        {bookDuration > 0 && viewStart + span > bookDuration ? (
          <div className="clip-dial-edge end" style={{ left: `${((bookDuration - viewStart) / span) * 100}%` }} aria-hidden="true"><span>End</span></div>
        ) : null}
        <div className="clip-dial-frame" aria-hidden="true" />
      </div>
      <div className="clip-dial-times" aria-hidden="true">
        <output>{formatTime(Math.round(range.startSeconds))}</output>
        <output>{formatTime(Math.round(range.endSeconds))}</output>
      </div>
      <p className="clip-dial-hint">Drag the ruler to move the clip; let go to hear it.</p>
    </div>
  );
}

function ClipRow({
  bookDuration,
  bookPosition,
  chapterSegments,
  clip,
  clips,
  continueFrom,
  previewPending,
  open,
  toggleOpen
}: {
  bookDuration: number;
  bookPosition: number;
  chapterSegments: ChapterSegment[];
  clip: Clip;
  clips: ReturnType<typeof useClips>;
  continueFrom: (clip: Clip) => void;
  open: boolean;
  toggleOpen: () => void;
  previewPending: boolean;
}) {
  const editorId = useId();
  const [range, setRange] = useState<ClipRange>({ startSeconds: clip.startSeconds, endSeconds: clip.endSeconds });
  const [title, setTitle] = useState(clip.title ?? "");
  const [note, setNote] = useState(clip.note ?? "");
  const [saving, setSaving] = useState(false);
  /** A save made in this view, confirmed until the next edit. */
  const [savedHere, setSavedHere] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const removalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmingRemoval) removalRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [confirmingRemoval]);

  const chapter = chapterAtBookPosition(chapterSegments, clip.startSeconds);
  const playing = clips.playingClipId === clip.id;
  const sharing = clips.sharingId === clip.id;
  const edited = range.startSeconds !== clip.startSeconds
    || range.endSeconds !== clip.endSeconds
    || title.trim() !== (clip.title ?? "")
    || note.trim() !== (clip.note ?? "");
  // What the listener hears is the trim in front of them, saved or not.
  const shown = open ? range : clip;
  const span = clipSpan(shown);
  const length = range.endSeconds - range.startSeconds;
  const seconds = Math.round(length);
  // One second either way, on whole seconds. A step the bounds swallow is not offered.
  const shorter = resizeClip(range, seconds - 1, bookDuration);
  const longer = resizeClip(range, seconds + 1, bookDuration);

  function resize(next: ClipRange) {
    haptic("light");
    setRange(next);
    if (playing) clips.playClip({ ...clip, ...next });
  }

  async function save() {
    setSaving(true);
    await clips.change(clip, { ...range, title: title.trim() || null, note: note.trim() || null });
    setSaving(false);
    setSavedHere(true);
  }

  return (
    <li className={`clip-row${open ? " open" : ""}${playing ? " playing" : ""}`}>
      <div className="clip-row-head">
        <button
          type="button"
          className="clip-play"
          disabled={previewPending}
          aria-label={playing ? "Stop and return to your place" : "Play this clip"}
          onClick={() => (playing ? clips.stopAudition() : clips.playClip({ ...clip, ...shown }))}
        >
          {previewPending ? <LoaderCircle size={16} className="spin-icon" /> : playing ? <Square size={15} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <button
          type="button"
          className="clip-summary"
          aria-expanded={open}
          aria-controls={editorId}
          aria-label={open ? `${clipName(clip, chapter?.title)}, back to all clips` : `Edit ${clipName(clip, chapter?.title)}`}
          onClick={() => {
            haptic("light");
            toggleOpen();
            setConfirmingRemoval(false);
          }}
        >
          <span className="clip-summary-text">
            <strong>{clipName(clip, chapter?.title)}</strong>
            {open ? (clip.pending ? <small>Waiting to sync</small> : null) : (
              <small>
                {formatTime(span.start)} – {formatTime(span.end)} · {span.length}
                {clip.pending ? " · Waiting to sync" : ""}
              </small>
            )}
            {clip.note && !open ? <span className="clip-note">{clip.note}</span> : null}
          </span>
          {open ? null : <span className="clip-row-edit" aria-hidden="true">Edit <ChevronRight size={16} /></span>}
        </button>
      </div>

      {open ? (
        <div id={editorId} className="clip-editor">
          <p className="clip-editor-hint">Previews keep your listening place.</p>
          <ClipDial
            bookDuration={bookDuration}
            range={range}
            playhead={playing ? bookPosition : null}
            onChange={setRange}
            onSettle={(settled) => clips.playClip({ ...clip, ...settled })}
          />
          <div className="clip-length">
            <span>Length</span>
            <div>
              <button
                type="button"
                aria-label="One second shorter"
                disabled={shorter.endSeconds - shorter.startSeconds >= length}
                onClick={() => resize(shorter)}
              >
                <Minus size={15} />
              </button>
              <span className="clip-length-picker">
                <select
                  aria-label="Clip length"
                  value={seconds}
                  onChange={(event) => resize(resizeClip(range, Number(event.currentTarget.value), bookDuration))}
                >
                  {(CLIP_LENGTHS.includes(seconds) ? CLIP_LENGTHS : [...CLIP_LENGTHS, seconds].sort((left, right) => left - right))
                    .filter((option) => option === seconds || bookDuration <= 0 || option <= bookDuration)
                    .map((option) => <option key={option} value={option}>{clipLengthLabel(option)}</option>)}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </span>
              <button
                type="button"
                aria-label="One second longer"
                disabled={longer.endSeconds - longer.startSeconds <= length}
                onClick={() => resize(longer)}
              >
                <Plus size={15} />
              </button>
            </div>
          </div>

          <label className="clip-field">
            <span>Name (optional)</span>
            <input
              type="text"
              maxLength={200}
              placeholder={chapter?.title ?? "Untitled clip"}
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label className="clip-field">
            <span>Note (optional)</span>
            <textarea
              rows={2}
              maxLength={2000}
              placeholder="Why you kept it"
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </label>

          {savedHere && !edited && !saving ? (
            <p className="clip-saved-status" role="status"><Check size={14} aria-hidden="true" /> Changes saved</p>
          ) : null}
          <div className="clip-actions">
            {edited || saving ? (
              <button type="button" className="clip-save" disabled={saving} onClick={() => void save()}>
                {saving ? <LoaderCircle size={14} className="spin-icon" /> : null}
                Save changes
              </button>
            ) : null}
            {clips.canExportAudio ? (
              <button
                type="button"
                disabled={clip.pending || edited || clips.sharingId !== null}
                title={clip.pending ? "Available once this clip reaches the server" : edited ? "Save your changes first" : undefined}
                onClick={() => void clips.share(clip)}
              >
                {sharing ? <LoaderCircle size={14} className="spin-icon" /> : <Share2 size={14} />}
                {sharing ? "Preparing" : "Share audio"}
              </button>
            ) : null}
            <button type="button" title="Moves your place in the book to this clip" onClick={() => continueFrom({ ...clip, ...range })}>
              <CornerDownRight size={14} /> Continue from here
            </button>
          </div>

          {/* Removal keeps a row of its own, so asking to confirm never moves the other actions. */}
          <div ref={removalRef} className={`clip-removal${confirmingRemoval ? " confirming" : ""}`}>
            {confirmingRemoval ? (
              <>
                <span role="status">Remove this clip for good?</span>
                <button type="button" onClick={() => setConfirmingRemoval(false)}>Keep it</button>
                <button
                  type="button"
                  className="clip-remove"
                  onClick={() => {
                    haptic("medium");
                    void clips.remove(clip);
                  }}
                >
                  <Trash2 size={14} /> Remove
                </button>
              </>
            ) : (
              <button type="button" className="clip-remove" onClick={() => setConfirmingRemoval(true)}>
                <Trash2 size={14} /> Remove clip
              </button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function ClipsSheet({
  book,
  bookDuration,
  bookPosition,
  chapterSegments,
  clips,
  close,
  continueFrom,
  previewPending = false,
  initialClipId = null,
  saveNow
}: {
  book: Book;
  bookDuration: number;
  bookPosition: number;
  chapterSegments: ChapterSegment[];
  clips: ReturnType<typeof useClips>;
  close: () => void;
  previewPending?: boolean;
  initialClipId?: string | null;
  /** Move the listener's place to the clip and keep playing from there. */
  continueFrom: (clip: Clip) => void;
  /** Present while this is the book playing: saves a clip at the current moment. */
  saveNow?: () => void;
}) {
  const dialogRef = useModalFocus<HTMLElement>(close);
  // The clip that brought the listener here opens ready to trim. Captured
  // once: the saved notice clears itself while the sheet is still up.
  const [openClipId, setOpenClipId] = useState(initialClipId ?? clips.lastSavedId);
  const selectedClip = clips.clips.find((clip) => clip.id === openClipId);
  const shownClips = selectedClip ? [selectedClip] : clips.clips;
  useEffect(() => {
    if (dialogRef.current) dialogRef.current.scrollTop = 0;
  }, [selectedClip?.id, dialogRef]);
  const count = clips.clips.length;
  return (
    <div className="sleep-sheet-layer" role="presentation">
      <button type="button" className="sleep-sheet-scrim" aria-label="Close clips" onClick={close} />
      <section ref={dialogRef} tabIndex={-1} className="sleep-sheet clip-sheet" role="dialog" aria-modal="true" aria-labelledby="clip-sheet-title">
        <div className="sleep-sheet-grabber" aria-hidden="true" />
        <header>
          {selectedClip ? <button type="button" className="icon-button" aria-label="All clips" onClick={() => setOpenClipId(null)}><ChevronLeft size={18} /></button> : null}
          <div>
            <span className="eyebrow"><Scissors size={13} /> {book.title}</span>
            <h2 id="clip-sheet-title">{selectedClip ? "Edit clip" : "Saved clips"}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={close}>
            <X size={18} />
          </button>
        </header>
        {!selectedClip && count > 0 ? (
          <p className="sleep-sheet-hint">
            {count} {count === 1 ? "clip" : "clips"}. Previews keep your listening place.
          </p>
        ) : null}
        {clips.loading ? <p className="sleep-sheet-hint" role="status">Loading clips…</p> : null}
        {clips.loadError ? (
          <p className="clip-load-error" role="alert">
            {clips.loadError}
            <button type="button" className="download-btn" onClick={clips.refresh}>Try again</button>
          </p>
        ) : null}
        {!clips.supported ? <p className="sleep-sheet-hint">Update your OperaLibre server to use saved clips.</p> : null}
        {!clips.loading && !clips.loadError && clips.supported && count === 0 ? (
          <div className="clip-empty">
            <span className="clip-ribbon-glyph" aria-hidden="true"><Scissors size={12} /></span>
            <div>
              <strong>No clips yet</strong>
              <p>{saveNow
                ? `Save the last ${CLIP_LEAD_SECONDS} seconds and the next ${CLIP_TAIL_SECONDS} from where you are now. The gold ribbon on the cover does the same.`
                : `In Now Playing, press the gold Clip ribbon on the cover to save the last ${CLIP_LEAD_SECONDS} seconds and the next ${CLIP_TAIL_SECONDS}.`}</p>
              {saveNow ? (
                <button type="button" className="clip-save-now" onClick={saveNow}>
                  <Scissors size={14} aria-hidden="true" /> Save a clip now
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {previewPending ? <p className="sleep-sheet-hint" role="status">Opening this book for preview…</p> : null}
        {clips.error ? (
          <p className="clip-error" role="alert">
            {clips.error}
            <button type="button" aria-label="Dismiss" onClick={clips.dismissError}><X size={14} /></button>
          </p>
        ) : null}
        {count > 0 ? (
          <ul className="clip-list">
            {shownClips.map((clip) => (
              <ClipRow
                key={clip.id}
                bookDuration={bookDuration}
                bookPosition={bookPosition}
                chapterSegments={chapterSegments}
                clip={clip}
                clips={clips}
                continueFrom={continueFrom}
                previewPending={previewPending}
                open={clip.id === openClipId}
                toggleOpen={() => setOpenClipId((current) => current === clip.id ? null : clip.id)}
              />
            ))}
          </ul>
        ) : null}
        {!clips.loading && !clips.loadError && !clips.canExportAudio && count > 0 ? (
          <p className="sleep-sheet-hint clip-sheet-footnote">
            Sharing a clip as audio needs ffmpeg on the server.
          </p>
        ) : null}
      </section>
    </div>
  );
}
