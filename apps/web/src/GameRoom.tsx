import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BookOpenText, Grid3X3, RotateCcw, Sparkles } from "lucide-react";
import { haptic } from "./native";
import {
  MATCH_GLYPHS,
  MATCH_KINDS,
  MATCH_SIZE,
  WORD_ATTEMPTS,
  WORD_LENGTH,
  cellsAreAdjacent,
  collapseMatches,
  WORDS,
  dailyWord,
  findMatches,
  hasLegalMove,
  makeMatchBoard,
  randomWord,
  scoreWord,
  swapCells,
  type LetterResult,
  type MatchBoard,
  type MatchCell
} from "./games";

type GameName = "words" | "match";
type WordSave = { word: string; guesses: string[] };
const WORD_SAVE_KEY = "operalibre.games.word-grid";
const MATCH_SAVE_KEY = "operalibre.games.chapter-match";

function isPlayableGuess(value: unknown): value is string {
  return typeof value === "string" && value.length === WORD_LENGTH && /^[a-z]+$/.test(value);
}

function readWordSave(): WordSave {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORD_SAVE_KEY) ?? "null") as WordSave | null;
    // The answer must come from the pool (an arbitrary string may be
    // unwinnable on the letter-only keyboard) and every guess must be a
    // well-formed word, or scoring throws mid-render.
    if (
      (WORDS as readonly string[]).includes(parsed?.word as string)
      && Array.isArray(parsed?.guesses)
      && parsed.guesses.length <= WORD_ATTEMPTS
      && parsed.guesses.every(isPlayableGuess)
    ) {
      return { word: parsed.word, guesses: parsed.guesses };
    }
  } catch { /* Start fresh if local storage was cleared or malformed. */ }
  return { word: dailyWord(), guesses: [] };
}

const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const RESULT_RANK: Record<LetterResult, number> = { absent: 0, present: 1, correct: 2 };

function WordGrid() {
  const [save, setSave] = useState(readWordSave);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("Guess the shelf’s five-letter word.");
  const answer = save.word;
  const finished = save.guesses.includes(answer) || save.guesses.length >= WORD_ATTEMPTS;

  useEffect(() => {
    try {
      localStorage.setItem(WORD_SAVE_KEY, JSON.stringify(save));
    } catch { /* Keep playing without persistence when storage is unavailable. */ }
  }, [save]);

  const guessResults = useMemo(() => save.guesses.map((guess) => scoreWord(guess, answer)), [save.guesses, answer]);

  // The best result each guessed letter has earned, to shade its key.
  const keyResults = useMemo(() => {
    const results: Partial<Record<string, LetterResult>> = {};
    guessResults.forEach((letterResults, guessIndex) => {
      letterResults.forEach((result, index) => {
        const letter = save.guesses[guessIndex][index];
        const known = results[letter];
        if (!known || RESULT_RANK[result] > RESULT_RANK[known]) results[letter] = result;
      });
    });
    return results;
  }, [guessResults, save.guesses]);

  function submit() {
    const guess = draft.toLowerCase();
    if (finished) return;
    if (guess.length !== WORD_LENGTH) {
      setMessage("Enter five letters first.");
      return;
    }
    const guesses = [...save.guesses, guess];
    setSave({ ...save, guesses });
    setDraft("");
    // The end of a game — won or spent — earns a firmer bump than a keystroke.
    if (guess === answer || guesses.length === WORD_ATTEMPTS) haptic("medium");
    setMessage(guess === answer ? "Beautifully read." : guesses.length === WORD_ATTEMPTS ? `The word was ${answer.toUpperCase()}.` : "Keep reading between the lines.");
  }

  function refresh() {
    haptic("light");
    setSave({ word: randomWord(answer), guesses: [] });
    setDraft("");
    setMessage("A fresh word is on the shelf.");
  }

  function pressKey(key: string) {
    if (finished) return;
    haptic("light");
    if (key === "enter") {
      submit();
      return;
    }
    if (key === "back") {
      setDraft((current) => current.slice(0, -1));
      return;
    }
    setDraft((current) => (current.length < WORD_LENGTH ? current + key : current));
  }

  const rows = Array.from({ length: WORD_ATTEMPTS }, (_, row) => save.guesses[row] ?? (row === save.guesses.length ? draft : ""));
  return <section className="game-card word-game" aria-label="Word Grid game">
    <div className="game-title-row">
      <span className="game-mark"><BookOpenText size={22} /></span>
      <div><span className="section-label">Word puzzle</span><h2>Word Grid</h2></div>
      <span className="game-stat">{save.guesses.length}/{WORD_ATTEMPTS}</span>
      <button className="game-reset" type="button" onClick={refresh} aria-label="New word"><RotateCcw size={16} /></button>
    </div>
    <div className="word-board-frame"><div className="word-board" aria-label="Word guesses">
      {rows.map((word, row) => {
        const result = guessResults[row] ?? [];
        return <div className="word-row" key={row}>
          {Array.from({ length: WORD_LENGTH }, (_, col) => <span className={`word-tile ${result[col] ?? ""}`} key={col}>{word[col]?.toUpperCase() ?? ""}</span>)}
        </div>;
      })}
    </div></div>
    <div className="word-keys" aria-label="Letter keyboard">
      {KEY_ROWS.map((rowKeys, rowIndex) => <div className="word-keys-row" key={rowIndex}>
        {rowIndex === 2 && <button type="button" className="word-key wide" disabled={finished || draft.length !== WORD_LENGTH} onClick={() => pressKey("enter")} aria-label="Submit guess">Enter</button>}
        {rowKeys.split("").map((letter) => (
          <button type="button" className={`word-key ${keyResults[letter] ?? ""}`} disabled={finished} onClick={() => pressKey(letter)} key={letter}>{letter.toUpperCase()}</button>
        ))}
        {rowIndex === 2 && <button type="button" className="word-key wide" disabled={finished || !draft.length} onClick={() => pressKey("back")} aria-label="Delete letter">⌫</button>}
      </div>)}
    </div>
    <p className="game-message" aria-live="polite">{message}</p>
  </section>;
}

type ScorePopup = { id: number; points: number; cascade: number; left: number; top: number };

function cellKey(cell: MatchCell) {
  return `${cell.row}:${cell.col}`;
}

function sameCell(left: MatchCell | null, right: MatchCell) {
  return left?.row === right.row && left.col === right.col;
}

// How far a press must travel before it reads as a swipe rather than a tap.
const SWIPE_DISTANCE = 12;
// Offset from a piece's center — in the same [-0.5, 0.5] fraction-of-piece
// units the tap handler computes — beyond which a retap of the selected piece
// reads as a reach for the neighbor on that side. Generous on purpose: a
// misread deselect is an annoyance, but a misread swap is irreversible.
const DESELECT_RADIUS = 0.3;

function neighborToward(cell: MatchCell, dx: number, dy: number): MatchCell | null {
  const next = Math.abs(dx) >= Math.abs(dy)
    ? { row: cell.row, col: cell.col + Math.sign(dx) }
    : { row: cell.row + Math.sign(dy), col: cell.col };
  const inBounds = next.row >= 0 && next.row < MATCH_SIZE && next.col >= 0 && next.col < MATCH_SIZE;
  return inBounds ? next : null;
}

function cellsThatFall(matches: Set<string>) {
  const lowestMatchByColumn = new Map<number, number>();
  matches.forEach((key) => {
    const [row, col] = key.split(":").map(Number);
    lowestMatchByColumn.set(col, Math.max(row, lowestMatchByColumn.get(col) ?? -1));
  });
  return new Set(
    [...lowestMatchByColumn].flatMap(([col, lowestRow]) =>
      Array.from({ length: lowestRow + 1 }, (_, row) => `${row}:${col}`)
    )
  );
}

const reducedMotionQuery = typeof window === "undefined" ? undefined : window.matchMedia?.("(prefers-reduced-motion: reduce)");

function motionDelay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, reducedMotionQuery?.matches ? 0 : milliseconds));
}

function readMatchSave(): { board: MatchBoard; score: number; bestCascade: number } {
  try {
    const stored = JSON.parse(localStorage.getItem(MATCH_SAVE_KEY) ?? "null") as { board?: unknown; score?: unknown; bestCascade?: unknown } | null;
    const board = stored?.board;
    const validBoard = Array.isArray(board) && board.length === MATCH_SIZE &&
      board.every((row) => Array.isArray(row) && row.length === MATCH_SIZE &&
        row.every((cell) => Number.isInteger(cell) && cell >= 0 && cell < MATCH_KINDS));
    const bestCascade = typeof stored?.bestCascade === "number" && Number.isFinite(stored.bestCascade) && stored.bestCascade > 0 ? Math.floor(stored.bestCascade) : 0;
    if (validBoard) {
      const score = typeof stored?.score === "number" && Number.isFinite(stored.score) && stored.score > 0 ? Math.floor(stored.score) : 0;
      // A restored board with no legal swap would strand the player; deal a
      // fresh board but let them keep their run.
      return { board: hasLegalMove(board as MatchBoard) ? (board as MatchBoard) : makeMatchBoard(), score, bestCascade };
    }
    // The record survives even a corrupted board — it's an all-time
    // achievement, not part of the in-progress run.
    return { board: makeMatchBoard(), score: 0, bestCascade };
  } catch { /* A fresh board is always safe. */ }
  return { board: makeMatchBoard(), score: 0, bestCascade: 0 };
}

function ChapterMatch() {
  const [board, setBoard] = useState<MatchBoard>(() => readMatchSave().board);
  const [score, setScore] = useState(() => readMatchSave().score);
  const [bestCascade, setBestCascade] = useState(() => readMatchSave().bestCascade);
  const [selected, setSelected] = useState<MatchCell | null>(null);
  const [message, setMessage] = useState("Tap two neighboring symbols to make a line of three.");
  const [busy, setBusy] = useState(false);
  const [swapping, setSwapping] = useState<{ from: MatchCell; to: MatchCell } | null>(null);
  const [clearing, setClearing] = useState<Set<string>>(new Set());
  const [falling, setFalling] = useState<Set<string>>(new Set());
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [scorePulse, setScorePulse] = useState(0);
  const [statusTick, setStatusTick] = useState(0);
  const [boardEpoch, setBoardEpoch] = useState(0);
  const [popups, setPopups] = useState<ScorePopup[]>([]);
  // Pieces only wear the entrance animation while this is set; otherwise
  // removing a modifier class (selected/falling/invalid) would flip
  // animation-name back to the entrance and visibly replay it.
  const [arriving, setArriving] = useState(true);
  const actionVersion = useRef(0);
  const popupSerial = useRef(0);
  const drag = useRef<{ pointerId: number; cell: MatchCell; x: number; y: number; swiped: boolean } | null>(null);
  const pendingTap = useRef<{ dx: number; dy: number } | null>(null);
  // Mirrors `busy` synchronously: pointer handlers can fire twice before a
  // re-render, and the state closure alone would let both swaps start.
  const busyRef = useRef(false);

  useEffect(() => {
    setArriving(true);
    const timer = window.setTimeout(() => setArriving(false), 900);
    return () => window.clearTimeout(timer);
  }, [boardEpoch]);

  function spawnPopup(matches: Set<string>, cascade: number) {
    const cells = [...matches].map((key) => key.split(":").map(Number));
    const id = ++popupSerial.current;
    setPopups((current) => [...current, {
      id,
      points: matches.size * 10,
      cascade,
      left: (cells.reduce((sum, [, col]) => sum + col + 0.5, 0) / cells.length / MATCH_SIZE) * 100,
      top: (cells.reduce((sum, [row]) => sum + row + 0.5, 0) / cells.length / MATCH_SIZE) * 100
    }]);
    window.setTimeout(() => setPopups((current) => current.filter((popup) => popup.id !== id)), 900);
  }

  useEffect(() => {
    try {
      localStorage.setItem(MATCH_SAVE_KEY, JSON.stringify({ board, score, bestCascade }));
    } catch { /* Keep playing without persistence when storage is unavailable. */ }
  }, [board, score, bestCascade]);
  useEffect(() => () => { actionVersion.current += 1; }, []);

  function announce(nextMessage: string) {
    setMessage(nextMessage);
    setStatusTick((value) => value + 1);
  }

  function markBusy(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }

  async function clearCascades(start: MatchBoard, version: number) {
    let nextBoard = start;
    let cascades = 0;
    for (; cascades < 12; cascades += 1) {
      const matches = findMatches(nextBoard);
      if (!matches.size) break;

      // A cascade the player didn't ask for lands harder than the match they did.
      haptic(cascades ? "medium" : "light");
      setClearing(matches);
      spawnPopup(matches, cascades);
      announce(cascades ? `Cascade ${cascades + 1}!` : `${matches.size} symbols aligned.`);
      await motionDelay(260);
      if (version !== actionVersion.current) return;

      nextBoard = collapseMatches(nextBoard, matches);
      setBoard(nextBoard);
      setClearing(new Set());
      setFalling(cellsThatFall(matches));
      setScore((value) => value + matches.size * 10);
      setScorePulse((value) => value + 1);
      await motionDelay(310);
      if (version !== actionVersion.current) return;
      setFalling(new Set());
    }

    let isNewRecord = false;
    setBestCascade((value) => {
      if (cascades <= value) return value;
      isNewRecord = true;
      return cascades;
    });

    if (!hasLegalMove(nextBoard)) {
      // Cascade refills can strand the board; reshuffle so endless play
      // stays endless, and keep the score.
      haptic("heavy");
      setBoard(makeMatchBoard());
      setBoardEpoch((value) => value + 1);
      announce("No moves remained — a fresh page is turned.");
    } else if (isNewRecord && cascades > 1) {
      haptic("heavy");
      announce(`New record — a ${cascades} chapter cascade!`);
    } else {
      announce(cascades > 1 ? `A ${cascades} chapter cascade!` : "Chapter cleared.");
    }
    markBusy(false);
  }

  async function performSwap(first: MatchCell, second: MatchCell) {
    if (busyRef.current) return;
    const swapped = swapCells(board, first, second);
    const matches = findMatches(swapped);
    const version = actionVersion.current + 1;
    actionVersion.current = version;
    haptic("light");
    markBusy(true);
    setSelected(null);
    setSwapping({ from: first, to: second });
    await motionDelay(190);
    if (version !== actionVersion.current) return;
    setBoard(swapped);
    setSwapping(null);

    if (!matches.size) {
      const invalidCells = new Set([cellKey(first), cellKey(second)]);
      haptic("medium");
      setInvalid(invalidCells);
      announce("No line there — returning those symbols.");
      await motionDelay(220);
      if (version !== actionVersion.current) return;
      setInvalid(new Set());
      setSwapping({ from: first, to: second });
      await motionDelay(190);
      if (version !== actionVersion.current) return;
      setBoard(board);
      setSwapping(null);
      markBusy(false);
      return;
    }

    await clearCascades(swapped, version);
  }

  function choose(cell: MatchCell, tapOffset?: { dx: number; dy: number }) {
    if (busyRef.current) return;
    if (!selected) {
      haptic("light");
      setSelected(cell);
      announce("Now choose a neighboring symbol.");
      return;
    }
    if (sameCell(selected, cell)) {
      // On small boards a retap near the piece's edge is almost always a
      // missed reach for the neighbor on that side; honor the intent instead
      // of deselecting. A tap near the center still deselects.
      const aimed = tapOffset && Math.max(Math.abs(tapOffset.dx), Math.abs(tapOffset.dy)) > DESELECT_RADIUS
        ? neighborToward(cell, tapOffset.dx, tapOffset.dy)
        : null;
      if (aimed) {
        void performSwap(cell, aimed);
        return;
      }
      setSelected(null);
      announce("Selection cleared.");
      return;
    }
    if (!cellsAreAdjacent(selected, cell)) {
      haptic("light");
      setSelected(cell);
      announce("Choose one of the glowing neighbors.");
      return;
    }
    void performSwap(selected, cell);
  }

  function reset() {
    haptic("light");
    actionVersion.current += 1;
    setBoard(makeMatchBoard());
    setScore(0);
    setSelected(null);
    markBusy(false);
    setSwapping(null);
    setClearing(new Set());
    setFalling(new Set());
    setInvalid(new Set());
    setPopups([]);
    setBoardEpoch((value) => value + 1);
    announce("A fresh volume is ready.");
  }

  return <section className="game-card match-game" aria-label="Chapter Match game">
    <div className="game-title-row">
      <span className="game-mark"><Grid3X3 size={22} /></span>
      <div><span className="section-label">Endless play</span><h2>Chapter Match</h2></div>
      <button className="game-reset" type="button" onClick={reset} aria-label="Reset Chapter Match"><RotateCcw size={16} /></button>
    </div>
    <div className="match-record"><span>Best cascade</span><strong>{bestCascade}</strong></div>
    <div className="match-score"><span>{busy ? "Resolving" : "Score"}</span><strong className={scorePulse ? "score-bump" : ""} key={scorePulse}>{score.toLocaleString()}</strong></div>
    <div className="match-board-frame"><div className={`match-board ${busy ? "busy" : ""} ${arriving ? "arriving" : ""}`} role="grid" aria-label="Matching board" aria-busy={busy}>
      {board.map((row, rowIndex) => row.map((kind, colIndex) => {
        const cell = { row: rowIndex, col: colIndex };
        const key = cellKey(cell);
        const active = sameCell(selected, cell);
        const neighbor = !!selected && cellsAreAdjacent(selected, cell);
        const swapTarget = swapping && (sameCell(swapping.from, cell) ? swapping.to : sameCell(swapping.to, cell) ? swapping.from : null);
        const style = swapTarget ? {
          "--match-x": `${(swapTarget.col - colIndex) * 100}%`,
          "--match-y": `${(swapTarget.row - rowIndex) * 100}%`,
          "--match-mid-x": `${(swapTarget.col - colIndex) * 55}%`,
          "--match-mid-y": `${(swapTarget.row - rowIndex) * 55}%`,
          "--match-delay": `${(rowIndex + colIndex) * 22}ms`
        } as CSSProperties : { "--match-delay": `${(rowIndex + colIndex) * 22}ms` } as CSSProperties;
        const classes = [
          "match-piece",
          `kind-${kind}`,
          active && "selected",
          neighbor && "neighbor",
          swapTarget && "swapping",
          clearing.has(key) && "clearing",
          falling.has(key) && "falling",
          invalid.has(key) && "invalid"
        ].filter(Boolean).join(" ");
        return <button
          type="button"
          role="gridcell"
          className={classes}
          style={style}
          aria-label={`Symbol at row ${rowIndex + 1}, column ${colIndex + 1}`}
          aria-selected={active}
          aria-disabled={busy}
          key={`${boardEpoch}:${key}`}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            // One gesture at a time: a second concurrent touch never steals
            // or corrupts the first finger's drag state.
            if (drag.current) return;
            pendingTap.current = null;
            drag.current = { pointerId: event.pointerId, cell, x: event.clientX, y: event.clientY, swiped: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || start.swiped || start.pointerId !== event.pointerId) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_DISTANCE) return;
            // A swipe swaps with the neighbor it points at — no second tap,
            // so no precision needed on small screens.
            start.swiped = true;
            const target = neighborToward(start.cell, dx, dy);
            // iOS can drop the final pointer-up when it transfers or loses
            // capture. Release our gesture lock before starting the async
            // swap, so that cannot leave the board tap-only until remount.
            drag.current = null;
            if (target) void performSwap(start.cell, target);
          }}
          onPointerUp={(event) => {
            const start = drag.current;
            if (!start || start.pointerId !== event.pointerId) return;
            drag.current = null;
            if (start.swiped) return;
            // Just note where the tap landed; the click event does the work,
            // so assistive tech and keyboards (click only, no pointer
            // sequence) activate pieces exactly the same way.
            const bounds = event.currentTarget.getBoundingClientRect();
            pendingTap.current = {
              dx: (event.clientX - bounds.left) / bounds.width - 0.5,
              dy: (event.clientY - bounds.top) / bounds.height - 0.5
            };
          }}
          onPointerCancel={(event) => {
            if (drag.current?.pointerId === event.pointerId) drag.current = null;
          }}
          onLostPointerCapture={(event) => {
            if (drag.current?.pointerId === event.pointerId) drag.current = null;
          }}
          onClick={() => {
            const offset = pendingTap.current;
            pendingTap.current = null;
            choose(cell, offset ?? undefined);
          }}
        >{MATCH_GLYPHS[kind]}</button>;
      }))}
      {popups.map((popup) => (
        <span
          className={`match-popup ${popup.cascade ? "cascade" : ""}`}
          style={{ left: `${popup.left}%`, top: `${popup.top}%` }}
          aria-hidden="true"
          key={popup.id}
        >{popup.cascade ? `×${popup.cascade + 1} ` : ""}+{popup.points}</span>
      ))}
    </div></div>
    {/* The live region stays mounted so screen readers announce updates; only
        the inner span remounts, to restart its entrance animation. */}
    <p className="game-message" aria-live="polite"><span className="match-message" key={statusTick}>{message}</span></p>
  </section>;
}

export function GamesPage() {
  const [game, setGame] = useState<GameName>("match");
  return <section className="games-shell" aria-label="Games">
    <header className="games-head"><span className="eyebrow"><Sparkles size={13} /> The Parlour</span><h1>Games</h1><p>Small diversions for long listens.</p></header>
    <div className="games-switcher" role="tablist" aria-label="Choose a game">
      <button type="button" role="tab" aria-selected={game === "match"} className={game === "match" ? "active" : ""} onClick={() => setGame("match")}><Grid3X3 size={16} /> Chapter Match</button>
      <button type="button" role="tab" aria-selected={game === "words"} className={game === "words" ? "active" : ""} onClick={() => setGame("words")}><BookOpenText size={16} /> Word Grid</button>
    </div>
    {game === "words" ? <WordGrid /> : <ChapterMatch />}
    <p className="games-privacy">Saved only on this device. No account or connection needed.</p>
  </section>;
}
