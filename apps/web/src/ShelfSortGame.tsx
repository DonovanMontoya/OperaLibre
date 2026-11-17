import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Library, Lightbulb, RotateCcw, Undo2 } from "lucide-react";
import { haptic } from "./native";
import {
  SHELF_CAPACITY,
  dealShelves,
  moveShelfBooks,
  shelfColorsForLevel,
  shelfFinished,
  shelfHasMove,
  shelfMoveCount,
  shelfSolution,
  shelfTopRun,
  shelvedCount,
  shelvesSorted,
  type ShelfMove,
  type ShelfStacks
} from "./games";

const SHELF_SAVE_KEY = "operalibre.games.shelf-sort";
// Volume numbers ride on every spine, so colour is never the only cue.
const VOLUMES = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;
const COLOR_NAMES = ["Oxblood", "Forest", "Navy", "Ochre", "Plum", "Teal", "Slate"] as const;
const HISTORY_LIMIT = 200;

type ShelfSave = { level: number; start: ShelfStacks; stacks: ShelfStacks; history: ShelfStacks[] };

function validStacks(value: unknown, colors: number): value is ShelfStacks {
  if (!Array.isArray(value) || value.length !== colors + 2) return false;
  const counts = Array<number>(colors).fill(0);
  for (const stack of value) {
    if (!Array.isArray(stack) || stack.length > SHELF_CAPACITY) return false;
    for (const book of stack) {
      if (!Number.isInteger(book) || book < 0 || book >= colors) return false;
      counts[book] += 1;
    }
  }
  return counts.every((count) => count === SHELF_CAPACITY);
}

function freshSave(level: number): ShelfSave {
  const start = dealShelves(shelfColorsForLevel(level));
  return { level, start, stacks: start, history: [] };
}

function readShelfSave(): ShelfSave {
  try {
    const stored = JSON.parse(localStorage.getItem(SHELF_SAVE_KEY) ?? "null") as Partial<ShelfSave> | null;
    const level = Number.isInteger(stored?.level) && stored!.level! > 0 ? stored!.level! : 1;
    const colors = shelfColorsForLevel(level);
    if (validStacks(stored?.start, colors) && validStacks(stored?.stacks, colors)) {
      const history = Array.isArray(stored?.history) ? stored.history.filter((entry) => validStacks(entry, colors)).slice(-HISTORY_LIMIT) : [];
      return { level, start: stored.start, stacks: stored.stacks, history };
    }
    return freshSave(level);
  } catch { /* A fresh deal is always safe. */ }
  return freshSave(1);
}

export function ShelfSort() {
  const [save, setSave] = useState(readShelfSave);
  const [selected, setSelected] = useState<number | null>(null);
  const [hint, setHint] = useState<ShelfMove | null>(null);
  // Which books just arrived, and which stack just refused; the tick replays
  // the cue on the books inside without remounting the focused button.
  const [landed, setLanded] = useState<{ stack: number; count: number; tick: number } | null>(null);
  const [rejected, setRejected] = useState<{ stack: number; tick: number } | null>(null);
  const [message, setMessage] = useState("Tap a stack, then the stack to move its top books onto.");
  const ticks = useRef(0);
  // The solution a hint came from, so following hints walks one line of play
  // instead of searching afresh (and perhaps doubling back) every time.
  const plan = useRef<{ key: string; moves: ShelfMove[] } | null>(null);
  const sorted = shelvesSorted(save.stacks);
  const moves = save.history.length;
  const colors = shelfColorsForLevel(save.level);
  const shelved = shelvedCount(save.stacks);

  useEffect(() => {
    try {
      localStorage.setItem(SHELF_SAVE_KEY, JSON.stringify(save));
    } catch { /* Keep playing without persistence when storage is unavailable. */ }
  }, [save]);

  function reject(stack: number, text: string) {
    haptic("medium");
    ticks.current += 1;
    setRejected({ stack, tick: ticks.current });
    setMessage(text);
  }

  function choose(index: number) {
    if (sorted) return;
    if (selected === null) {
      if (!save.stacks[index].length) {
        reject(index, "That stack is empty. Pick one with books on it.");
        return;
      }
      haptic("light");
      setSelected(index);
      setMessage("Now tap where those books go.");
      return;
    }
    if (selected === index) {
      setSelected(null);
      setMessage("Selection cleared.");
      return;
    }
    const count = shelfMoveCount(save.stacks, selected, index);
    if (!count) {
      const full = save.stacks[index].length >= SHELF_CAPACITY;
      reject(index, full ? "That stack is full." : "Books only go on an empty stack or the same colour.");
      setSelected(null);
      return;
    }
    const stacks = moveShelfBooks(save.stacks, selected, index);
    const history = [...save.history, save.stacks].slice(-HISTORY_LIMIT);
    const step = plan.current?.moves[0];
    plan.current = plan.current && step?.from === selected && step.to === index
      ? { key: JSON.stringify(stacks), moves: plan.current.moves.slice(1) }
      : null;
    ticks.current += 1;
    setLanded({ stack: index, count, tick: ticks.current });
    setSave({ ...save, stacks, history });
    setSelected(null);
    setHint(null);
    if (shelvesSorted(stacks)) {
      haptic("heavy");
      setMessage(`Shelf ${save.level} sorted in ${history.length} moves.`);
    } else if (!shelfHasMove(stacks)) {
      haptic("medium");
      setMessage("No books can move now. Undo to step back, or restart the shelf.");
    } else {
      haptic("light");
      const nowShelved = shelvedCount(stacks);
      setMessage(nowShelved > shelved
        ? `${COLOR_NAMES[stacks[index][0]]} is shelved. ${nowShelved} of ${colors} done.`
        : count > 1 ? `Moved ${count} books.` : "Moved.");
    }
  }

  function showHint() {
    if (sorted) return;
    haptic("light");
    setSelected(null);
    const key = JSON.stringify(save.stacks);
    if (plan.current?.key !== key || !plan.current.moves.length) {
      const found = shelfSolution(save.stacks);
      if (found === "stuck") {
        plan.current = null;
        setHint(null);
        setMessage("This shelf can no longer be sorted. Undo a few moves, or restart it.");
        return;
      }
      if (!found?.length) {
        plan.current = null;
        setHint(null);
        setMessage("No hint this time. Try undoing a move or two.");
        return;
      }
      plan.current = { key, moves: found };
    }
    const next = plan.current.moves[0];
    const run = shelfMoveCount(save.stacks, next.from, next.to);
    const name = COLOR_NAMES[save.stacks[next.from][save.stacks[next.from].length - 1]];
    setHint(next);
    setMessage(`Move ${run > 1 ? `the ${run} ${name} books` : `the ${name} book`} from stack ${next.from + 1} to stack ${next.to + 1}.`);
  }

  function undo() {
    if (!save.history.length || sorted) return;
    haptic("light");
    plan.current = null;
    setSave({ ...save, stacks: save.history[save.history.length - 1], history: save.history.slice(0, -1) });
    setSelected(null);
    setHint(null);
    setLanded(null);
    setMessage("Move taken back.");
  }

  function restart() {
    haptic("light");
    plan.current = null;
    setSave({ ...save, stacks: save.start, history: [] });
    setSelected(null);
    setHint(null);
    setLanded(null);
    setMessage("Back to how the shelf was dealt.");
  }

  function nextShelf() {
    haptic("light");
    setSave(freshSave(save.level + 1));
    setSelected(null);
    setHint(null);
    setLanded(null);
    plan.current = null;
    setMessage(shelfColorsForLevel(save.level + 1) > colors
      ? "A new colour joins the shelf."
      : "A fresh shelf to sort.");
  }

  const rows = save.stacks.length > 5 ? 2 : 1;
  const perRow = Math.ceil(save.stacks.length / rows);
  // The run that would lift with the selected stack's top book.
  const lifted = selected === null ? 0 : shelfTopRun(save.stacks[selected]);
  const hintRun = hint ? shelfMoveCount(save.stacks, hint.from, hint.to) : 0;

  function stackButton(index: number) {
    const stack = save.stacks[index];
    const active = selected === index;
    const target = selected !== null && !active && shelfMoveCount(save.stacks, selected, index) > 0;
    const done = shelfFinished(stack);
    const top = stack.length ? COLOR_NAMES[stack[stack.length - 1]] : null;
    const contents = stack.length ? stack.map((book) => COLOR_NAMES[book]).join(", ") : "empty";
    // Where arriving books would sit: shown on every stack that can take them.
    const opening = target || hint?.to === index ? stack.length : -1;
    const arriving = landed?.stack === index ? stack.length - landed.count : SHELF_CAPACITY;
    return <button
      type="button"
      className={["shelf-stack", active && "selected", target && "target", done && "shelved",
        hint?.from === index && "hint-from", hint?.to === index && "hint-to", rejected?.stack === index && "rejected"].filter(Boolean).join(" ")}
      key={index}
      aria-label={`Stack ${index + 1}, bottom to top: ${contents}${top ? `. ${top} on top` : ""}${done ? ". Shelved" : ""}`}
      aria-pressed={active}
      onClick={() => choose(index)}
    >
      <span className="shelf-books" key={rejected?.stack === index ? rejected.tick : 0}>
        {Array.from({ length: SHELF_CAPACITY }, (_, slot) => {
          const book = stack[slot];
          if (book === undefined) return <span className={`shelf-slot ${slot === opening ? "opening" : ""}`} key={slot} />;
          const lifting = (active && slot >= stack.length - lifted) || (hint?.from === index && slot >= stack.length - hintRun);
          const landing = slot >= arriving;
          return <span
            className={["shelf-book", `color-${book}`, lifting && "lifting", landing && "landing"].filter(Boolean).join(" ")}
            key={landing ? `${slot}:${landed!.tick}` : slot}
            aria-hidden="true"
          >
            <span>{VOLUMES[book]}</span>
          </span>;
        })}
      </span>
      {done && <span className="shelf-plate" aria-hidden="true"><Check size={11} strokeWidth={3} /></span>}
    </button>;
  }

  return <section className="game-card match-game shelf-game" aria-label="Shelf Sort game">
    <div className="game-title-row">
      <span className="game-mark"><Library size={22} /></span>
      <div><span className="section-label">Sorting puzzle</span><h2>Shelf Sort</h2></div>
      <span className="game-controls">
        <button className="game-reset" type="button" onClick={showHint} disabled={sorted} aria-label="Show a hint"><Lightbulb size={16} /></button>
        <button className="game-reset" type="button" onClick={undo} disabled={!moves || sorted} aria-label="Undo move"><Undo2 size={16} /></button>
        <button className="game-reset" type="button" onClick={restart} disabled={!moves || sorted} aria-label="Restart this shelf"><RotateCcw size={16} /></button>
      </span>
    </div>
    <div className="match-record"><span>Shelf {save.level}</span><strong>{shelved} of {colors} shelved</strong></div>
    <div className="match-score"><span>Moves</span><strong>{moves}</strong></div>
    <div className="match-play-area">
      <div className="match-board-frame">
        <div
          className={`match-board shelf-board ${sorted ? "sorted" : ""}`}
          style={{ "--shelf-columns": perRow, "--shelf-rows": rows } as CSSProperties}
          role="group"
          aria-label="Book stacks"
        >
          {Array.from({ length: rows }, (_, row) => <div className="shelf-row" key={row}>
            {save.stacks.slice(row * perRow, (row + 1) * perRow).map((_, offset) => stackButton(row * perRow + offset))}
          </div>)}
          {sorted && <div className="shelf-done">
            <strong>Shelf {save.level} sorted</strong>
            <span>{moves} moves</span>
            <button type="button" onClick={nextShelf}>Next shelf</button>
          </div>}
        </div>
      </div>
      <p className="game-message" aria-live="polite">{message}</p>
    </div>
  </section>;
}
