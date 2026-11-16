import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Eye, Hash, Image as ImageIcon, ImagePlus } from "lucide-react";
import { bookHasCover, fallbackPicture, makeCoverPicture, type CoverPicture } from "./coverPicture";
import { SLIDE_SIZES, shuffleSlide, shuffled, slideFromArrow, slideSolvable, slideSolved, slideTiles, type SlideSize } from "./games";
import { haptic } from "./native";
import type { Book } from "./types";

const COVER_SAVE_KEY = "operalibre.games.cover-grid";
const RECENT_LIMIT = 8;
// How many covers to try before settling for a plate of our own: a library
// can hold covers this device cannot read (a server that went away).
const COVER_ATTEMPTS = 5;

type CoverSave = {
  puzzle: CoverPicture | null;
  size: SlideSize;
  tiles: number[];
  moves: number;
  numbers: boolean;
  solved: number;
  recent: string[];
};

function validPuzzle(value: unknown): value is CoverPicture {
  const puzzle = value as CoverPicture | null;
  return !!puzzle
    && typeof puzzle.title === "string"
    && (puzzle.bookId === null || typeof puzzle.bookId === "string")
    && typeof puzzle.image === "string" && puzzle.image.startsWith("data:image/");
}

function validTiles(value: unknown, size: number): value is number[] {
  return Array.isArray(value) && value.length === size * size
    && [...value].sort((left, right) => left - right).every((piece, index) => piece === index)
    && slideSolvable(value, size);
}

function readCoverSave(): CoverSave {
  const empty: CoverSave = { puzzle: null, size: 3, tiles: shuffleSlide(3), moves: 0, numbers: false, solved: 0, recent: [] };
  try {
    const stored = JSON.parse(localStorage.getItem(COVER_SAVE_KEY) ?? "null") as Partial<CoverSave> | null;
    if (!stored) return empty;
    const size = SLIDE_SIZES.includes(stored.size as SlideSize) ? stored.size as SlideSize : 3;
    const solved = Number.isInteger(stored.solved) && stored.solved! > 0 ? stored.solved! : 0;
    const recent = Array.isArray(stored.recent) ? stored.recent.filter((id): id is string => typeof id === "string").slice(-RECENT_LIMIT) : [];
    // A save from the picture-logic version of this game has no tiles: keep
    // its count and recent covers, and deal a fresh puzzle.
    const playable = validPuzzle(stored.puzzle) && validTiles(stored.tiles, size);
    return {
      puzzle: playable ? stored.puzzle! : null,
      size,
      tiles: playable ? stored.tiles! : shuffleSlide(size),
      moves: playable && Number.isInteger(stored.moves) && stored.moves! > 0 ? stored.moves! : 0,
      numbers: stored.numbers === true,
      solved,
      recent
    };
  } catch { /* Start fresh if local storage was cleared or malformed. */ }
  return empty;
}

export function CoverGrid({ books }: { books: Book[] }) {
  const [save, setSave] = useState(readCoverSave);
  const [loading, setLoading] = useState(false);
  const [peek, setPeek] = useState(false);
  // A choice that would throw progress away, waiting on a second tap.
  const [armed, setArmed] = useState<"new" | SlideSize | null>(null);
  const [bumped, setBumped] = useState<{ piece: number; tick: number } | null>(null);
  const [message, setMessage] = useState("Tap a piece in line with the gap to slide it. The picture is one of your covers.");
  const ticks = useRef(0);
  const generation = useRef<AbortController | null>(null);
  const booksRef = useRef(books);
  booksRef.current = books;
  const { puzzle, size, tiles } = save;
  const gap = size * size - 1;
  const solved = !!puzzle && !loading && slideSolved(tiles);

  useEffect(() => {
    try {
      localStorage.setItem(COVER_SAVE_KEY, JSON.stringify(save));
    } catch { /* Keep playing without persistence when storage is unavailable. */ }
  }, [save]);

  useEffect(() => {
    if (armed === null) return;
    const timer = window.setTimeout(() => setArmed(null), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const newPuzzle = useCallback(async (nextSize: SlideSize) => {
    generation.current?.abort();
    const controller = new AbortController();
    generation.current = controller;
    setLoading(true);
    setArmed(null);
    setPeek(false);
    setMessage("Finding a cover…");
    const current = readCoverSave();
    const candidates = booksRef.current.filter(bookHasCover);
    // Covers not seen lately come first; with a small library, repeats follow.
    const fresh = shuffled(candidates.filter((book) => !current.recent.includes(book.id)));
    const repeats = shuffled(candidates.filter((book) => current.recent.includes(book.id) && book.id !== current.puzzle?.bookId));
    let next: CoverPicture | null = null;
    for (const book of [...fresh, ...repeats].slice(0, COVER_ATTEMPTS)) {
      try {
        next = await makeCoverPicture(book, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
      }
      if (controller.signal.aborted) return;
      if (next) break;
    }
    const puzzle = next ?? fallbackPicture();
    setSave((previous) => ({
      ...previous,
      puzzle,
      size: nextSize,
      tiles: shuffleSlide(nextSize),
      moves: 0,
      recent: puzzle.bookId ? [...previous.recent.filter((id) => id !== puzzle.bookId), puzzle.bookId].slice(-RECENT_LIMIT) : previous.recent
    }));
    setLoading(false);
    setMessage(puzzle.bookId
      ? "Which book is it? Slide the pieces back into place to find out."
      : "No cover could be read, so here is a plate of our own.");
  }, []);

  useEffect(() => {
    const stored = readCoverSave();
    if (!stored.puzzle) void newPuzzle(stored.size);
    return () => generation.current?.abort();
  }, [newPuzzle]);

  const wasSolved = useRef(solved);
  useEffect(() => {
    if (solved && !wasSolved.current) {
      haptic("heavy");
      setSave((previous) => ({ ...previous, solved: previous.solved + 1 }));
      setPeek(false);
      const moves = `${save.moves} ${save.moves === 1 ? "move" : "moves"}`;
      setMessage(puzzle?.bookId
        ? `It’s ${puzzle.title}, in ${moves}.`
        : `Solved in ${moves}. Add covers to your library to slide your own books.`);
    }
    wasSolved.current = solved;
  }, [solved, puzzle, save.moves]);

  function slide(position: number) {
    if (solved || loading || peek) return;
    const next = slideTiles(tiles, size, position);
    if (!next) {
      haptic("medium");
      ticks.current += 1;
      setBumped({ piece: tiles[position], tick: ticks.current });
      setMessage("Only pieces in the gap’s row or column can slide.");
      return;
    }
    haptic("light");
    setArmed(null);
    setSave((previous) => ({ ...previous, tiles: next, moves: previous.moves + 1 }));
  }

  function onBoardKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const from = slideFromArrow(tiles, size, event.key);
    if (from === null) return;
    event.preventDefault();
    slide(from);
  }

  function askForNewPuzzle() {
    if (save.moves && !solved && armed !== "new") {
      haptic("medium");
      setArmed("new");
      setMessage("Tap New picture again to start a different cover. This one’s progress will go.");
      return;
    }
    void newPuzzle(size);
  }

  function chooseSize(next: SlideSize) {
    if (next === size || loading) return;
    if (save.moves && !solved && armed !== next) {
      haptic("medium");
      setArmed(next);
      setMessage(`Tap ${next}×${next} again to cut this cover again. This shuffle’s progress will go.`);
      return;
    }
    haptic("light");
    setArmed(null);
    setPeek(false);
    setSave((previous) => ({ ...previous, size: next, tiles: shuffleSlide(next), moves: 0 }));
    setMessage(`Cut into ${next * next - 1} pieces and shuffled.`);
  }

  const boardStyle = {
    "--slide-size": size,
    ...(puzzle ? { "--slide-image": `url("${puzzle.image}")` } : {})
  } as CSSProperties;

  return <section className="game-card match-game cover-game" aria-label="Cover Grid game">
    <div className="game-title-row">
      <span className="game-mark"><ImageIcon size={22} /></span>
      <div><span className="section-label">Sliding puzzle</span><h2>Cover Grid</h2></div>
      <span className="game-controls">
        <span className="game-stat">{save.moves} {save.moves === 1 ? "move" : "moves"}</span>
        <button
          className={`game-reset ${armed === "new" ? "armed" : ""}`}
          type="button"
          onClick={askForNewPuzzle}
          disabled={loading}
          aria-label={armed === "new" ? "Confirm new picture" : "New picture"}
        ><ImagePlus size={16} /></button>
      </span>
    </div>
    <div className="match-record"><span>Pictures solved</span><strong>{save.solved}</strong></div>
    <div className="match-score cover-tools">
      <div className="cover-tool-group" role="radiogroup" aria-label="Puzzle size">
        {SLIDE_SIZES.map((option) => <button
          type="button"
          role="radio"
          aria-checked={size === option}
          aria-label={armed === option ? `Confirm ${option} by ${option}` : `${option} by ${option}`}
          className={[size === option && "active", armed === option && "armed"].filter(Boolean).join(" ")}
          onClick={() => chooseSize(option)}
          disabled={loading}
          key={option}
        >{option}×{option}</button>)}
      </div>
      <div className="cover-tool-pair">
        <button
          className={`cover-action ${save.numbers ? "on" : ""}`}
          type="button"
          aria-pressed={save.numbers}
          aria-label="Show piece numbers"
          onClick={() => setSave((previous) => ({ ...previous, numbers: !previous.numbers }))}
        ><Hash size={15} /></button>
        <button
          className={`cover-action ${peek ? "on" : ""}`}
          type="button"
          aria-pressed={peek}
          aria-label="Peek at the cover"
          onClick={() => setPeek((value) => !value)}
          disabled={!puzzle || loading || solved}
        ><Eye size={15} /></button>
      </div>
    </div>
    <div className="match-play-area">
      <div className="match-board-frame">
        <div
          className={["match-board", "slide-board", solved && "solved", loading && "loading"].filter(Boolean).join(" ")}
          style={boardStyle}
          role="group"
          aria-label="Sliding puzzle. Arrow keys slide a piece into the gap."
          aria-busy={loading}
          tabIndex={0}
          onKeyDown={onBoardKeyDown}
        >
          {puzzle && tiles.map((piece, position) => {
            // The gap's own piece only appears once the rest are home.
            if (piece === gap && !solved) return null;
            const movable = !solved && slideTiles(tiles, size, position) !== null;
            const home = piece === position;
            return <button
              type="button"
              // Keyed by piece, so a slide moves the same element and animates.
              key={`${size}:${piece}`}
              className={["slide-tile", home && "home", piece === gap && "final"].filter(Boolean).join(" ")}
              style={{
                "--row": Math.floor(position / size),
                "--col": position % size,
                "--home-row": Math.floor(piece / size),
                "--home-col": piece % size
              } as CSSProperties}
              tabIndex={-1}
              aria-label={`Piece ${piece + 1}${home ? ", in place" : ""}${movable ? ", can slide" : ""}`}
              onClick={() => slide(position)}
            >
              <span className={`slide-face ${bumped?.piece === piece ? "bumped" : ""}`} key={bumped?.piece === piece ? bumped.tick : 0}>
                {save.numbers && piece !== gap && !solved && <span className="slide-number">{piece + 1}</span>}
              </span>
            </button>;
          })}
          {peek && puzzle && <button type="button" className="slide-peek" onClick={() => setPeek(false)} aria-label="Hide the cover">
            <img src={puzzle.image} alt="" />
          </button>}
        </div>
      </div>
      <p className="game-message" aria-live="polite">{message}</p>
    </div>
  </section>;
}
