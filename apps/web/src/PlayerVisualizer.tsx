import { useEffect, useLayoutEffect, useRef } from "react";
import { AudioLines, Maximize2, Minimize2 } from "lucide-react";
import { PLAYER_VISUALIZERS, type PlayerVisualizerMode as Mode } from "./playbackPreferences";

const LABELS: Record<Mode, string> = { off: "Visualizer", halo: "Halo", blocks: "Blocks", bloom: "Bloom" };

/** Room around the cover the halo and bloom draw into beside the controls. */
const BLEED = 36;
/** On the stage they reach into the open space, up to this far. */
const STAGE_REACH = 220;
/** Halo bars sit this far apart along the cover's edge, whatever its size. */
const HALO_SPACING = 7;
/** Milliseconds to fade a style in, and out: turning on, pausing, switching. */
const FADE_IN = 420;
const FADE_OUT = 220;
/**
 * Paused on the stage, the drawing settles to a still picture this faint
 * rather than leaving the stage bare, slowing to a stop over `SETTLE` ms.
 */
const REST = 0.5;
const SETTLE = 900;
/**
 * Paints a second while playing. Speech needs no more, and a faster display
 * would only spend more of a modest machine's time on the same picture.
 */
const FRAME = 1000 / 30;

type Rgb = [number, number, number];
type Point = { x: number; y: number; nx: number; ny: number };
/**
 * The cover's box inside the canvas (`x`, `y`, `w`, `h`, corner radius `r`),
 * the canvas's own size, how far the drawing may reach past the cover's edge,
 * and the points along its outline the halo's bars stand on, worked out once
 * per resize rather than per frame.
 */
type Cover = {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  width: number;
  height: number;
  reach: number;
  staged: boolean;
  halo: Point[];
};
/**
 * What every style draws with: the cover, the analyser's latest data, where
 * the palette has drifted to, `grow` — 0 to 1 as the style fades in or out,
 * so it rises from the cover rather than only changing opacity — and `pace`,
 * 1 while playing and easing to 0 on pause, for anything that drifts by itself.
 */
type Frame = {
  ctx: CanvasRenderingContext2D;
  cover: Cover;
  freq: Uint8Array;
  phase: number;
  grow: number;
  pace: number;
};

/** Rose, amber, teal, blue, violet: a loop, so the drift never jumps. */
const PALETTE: Rgb[] = [[255, 77, 109], [255, 176, 0], [46, 196, 182], [58, 134, 255], [131, 56, 236]];

function paletteAt(t: number): Rgb {
  const at = (((t % 1) + 1) % 1) * PALETTE.length;
  const from = PALETTE[Math.floor(at)];
  const to = PALETTE[(Math.floor(at) + 1) % PALETTE.length];
  const k = at - Math.floor(at);
  return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * k)) as Rgb;
}

const rgba = ([r, g, b]: Rgb, alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

/**
 * Evenly spaced points around the cover's rounded outline, clockwise from top
 * centre, each with its outward normal. Computed once per size, not per frame.
 */
function outline(w: number, h: number, r: number, count: number): Point[] {
  const arc = (Math.PI * r) / 2;
  const segments: ({ len: number } & ({ line: [number, number, number, number, number, number] } | { arc: [number, number, number] }))[] = [
    { len: w / 2 - r, line: [w / 2, 0, w - r, 0, 0, -1] },
    { len: arc, arc: [w - r, r, -Math.PI / 2] },
    { len: h - 2 * r, line: [w, r, w, h - r, 1, 0] },
    { len: arc, arc: [w - r, h - r, 0] },
    { len: w - 2 * r, line: [w - r, h, r, h, 0, 1] },
    { len: arc, arc: [r, h - r, Math.PI / 2] },
    { len: h - 2 * r, line: [0, h - r, 0, r, -1, 0] },
    { len: arc, arc: [r, r, Math.PI] },
    { len: w / 2 - r, line: [r, 0, w / 2, 0, 0, -1] }
  ];
  const total = segments.reduce((sum, segment) => sum + segment.len, 0);
  const points: Point[] = [];
  for (let i = 0; i < count; i += 1) {
    let distance = (i / count) * total;
    const segment = segments.find((candidate) => {
      if (distance <= candidate.len) return true;
      distance -= candidate.len;
      return false;
    }) ?? segments[segments.length - 1];
    const t = segment.len > 0 ? distance / segment.len : 0;
    if ("line" in segment) {
      const [x0, y0, x1, y1, nx, ny] = segment.line;
      points.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, nx, ny });
    } else {
      const [cx, cy, start] = segment.arc;
      const angle = start + t * (Math.PI / 2);
      points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, nx: Math.cos(angle), ny: Math.sin(angle) });
    }
  }
  return points;
}

/** Spoken word sits low in the spectrum; spread ~86 Hz–8.6 kHz evenly by pitch. */
function binAt(freq: Uint8Array, t: number) {
  const index = 2 * Math.pow(100, t);
  const low = Math.floor(index);
  const high = Math.min(freq.length - 1, low + 1);
  return (freq[low] + (freq[high] - freq[low]) * (index - low)) / 255;
}

function bandLevel(freq: Uint8Array, from: number, to: number) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += binAt(freq, from + ((to - from) * i) / 11);
  return sum / 12;
}

function drawHalo({ ctx, cover, freq, phase, grow }: Frame) {
  const inner = cover.staged ? 8 : 5;
  const span = (cover.reach - inner - 12) * grow;
  ctx.beginPath();
  cover.halo.forEach((point, i) => {
    // Mirrored left and right, with the lows gathered at the bottom.
    const fromTop = 1 - Math.abs(1 - (2 * i) / cover.halo.length);
    const level = Math.pow(Math.max(0, (binAt(freq, 1 - fromTop) - 0.18) / 0.82), 1.35);
    const outer = inner + 2 + level * span;
    ctx.moveTo(point.x + point.nx * inner, point.y + point.ny * inner);
    ctx.lineTo(point.x + point.nx * outer, point.y + point.ny * outer);
  });
  // Warm where the lows are, cool up among the highs, mirrored to match.
  const sweep = ctx.createConicGradient(-Math.PI / 2, cover.w / 2, cover.h / 2);
  for (let k = 0; k <= 12; k += 1) {
    const fromTop = 1 - Math.abs(1 - (2 * k) / 12);
    sweep.addColorStop(k / 12, rgba(paletteAt(phase + 0.75 - fromTop * 0.75), 0.95));
  }
  ctx.lineCap = "round";
  ctx.strokeStyle = sweep;
  // A wide faint pass under the crisp one glows for less than shadowBlur.
  ctx.globalAlpha *= 0.28;
  ctx.lineWidth = cover.staged ? 9 : 7;
  ctx.stroke();
  ctx.globalAlpha /= 0.28;
  ctx.lineWidth = cover.staged ? 3.6 : 2.6;
  ctx.stroke();
}

type Coin = { x: number; y: number; age: number };
/** Each column's eased height and floating peak, 0 to 1, and the coins in the air. */
type BlocksState = { heights: Float32Array; peaks: Float32Array; coins: Coin[]; scroll: number };
const blocksState = (scroll = 0): BlocksState => ({ heights: new Float32Array(0), peaks: new Float32Array(0), coins: [], scroll });

const GROUND: Rgb = [200, 76, 12];
const GOLD: Rgb = [252, 168, 52];
const HILL: Rgb = [40, 176, 72];
/** Drawn on an 8×8 grid inside a question block. */
const QUESTION = ["..####..", ".##..##.", ".....##.", "....##..", "...##...", "........", "...##..."];
const CLOUD = ["..##....", ".####.#.", "########"];

const shade = ([r, g, b]: Rgb, k: number): Rgb =>
  k > 0 ? [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k] : [r * (1 + k), g * (1 + k), b * (1 + k)];
const mortar = (tile: number) => Math.max(1, Math.round(tile / 10));

/**
 * Bricks in rows and stacks, as one path per colour: a lit top edge, the
 * mortar and a shaded right edge for each, so a stack is three fills.
 */
function bricks(ctx: CanvasRenderingContext2D, color: Rgb, tiles: [number, number][], tile: number) {
  if (!tiles.length) return;
  const m = mortar(tile);
  const half = Math.round(tile / 2);
  ctx.fillStyle = rgba(color, 1);
  tiles.forEach(([x, y]) => ctx.fillRect(x, y, tile, tile));
  ctx.beginPath();
  tiles.forEach(([x, y]) => ctx.rect(x, y, tile, m));
  ctx.fillStyle = rgba(shade(color, 0.45), 1);
  ctx.fill();
  ctx.beginPath();
  tiles.forEach(([x, y]) => {
    ctx.rect(x, y + half, tile, m);
    ctx.rect(x, y + tile - m, tile, m);
    ctx.rect(x + tile - m, y, m, tile);
    ctx.rect(x + half, y, m, half);
    ctx.rect(x, y + half, m, half);
  });
  ctx.fillStyle = rgba(shade(color, -0.55), 1);
  ctx.fill();
}

function pixels(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, size: number) {
  ctx.beginPath();
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i += 1) if (row[i] === "#") ctx.rect(x + i * size, y + j * size, size, size);
  });
  ctx.fill();
}

/**
 * A side-scrolling block level: the voice's spectrum stacks bricks up from
 * the ground, lows at the edges, with a question block floating where each
 * column last peaked and a coin popping out when one is beaten. On the stage
 * hills and clouds scroll past behind it.
 */
function drawBlocks({ ctx, cover, freq, phase, grow, pace }: Frame, state: BlocksState, dt: number) {
  const { w, h, r, staged } = cover;
  const left = staged ? -cover.x : 0;
  const right = staged ? cover.width - cover.x : w;
  const floor = staged ? cover.height - cover.y : h;
  const tile = Math.round(staged ? Math.min(32, Math.max(14, cover.height / 22)) : Math.min(18, Math.max(8, w / 18)));
  const ground = floor - (staged ? 2 : 1) * tile;
  const count = Math.floor((right - left) / tile);
  const start = Math.round(left + (right - left - count * tile) / 2);
  const most = Math.max(2, Math.floor(((staged ? ground * 0.7 + cover.y : h * 0.42)) / tile));
  if (state.heights.length !== count) {
    state.heights = new Float32Array(count);
    state.peaks = new Float32Array(count);
    state.coins = [];
  }
  ctx.save();
  if (!staged) {
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, r);
    ctx.clip();
    const dusk = ctx.createLinearGradient(0, h * 0.4, 0, h);
    dusk.addColorStop(0, "rgba(14, 10, 7, 0)");
    dusk.addColorStop(1, "rgba(14, 10, 7, 0.7)");
    ctx.fillStyle = dusk;
    ctx.fillRect(0, h * 0.4, w, h * 0.6);
  }

  const loud = bandLevel(freq, 0, 1);
  state.scroll += dt * pace * (tile / 260) * (0.35 + 1.6 * loud);
  const along = (speed: number, period: number) => -((state.scroll * speed) % period);

  if (staged) {
    // Hills, then clouds, each slower than the ground so the level has depth.
    // Counted from the scroll, so each keeps its shape as it passes.
    const scenery = (speed: number, gap: number, each: (x: number, k: number) => void) => {
      const travelled = state.scroll * speed;
      for (let k = -1; left + k * gap - (travelled % gap) < right + gap; k += 1) {
        each(Math.round(left + k * gap - (travelled % gap)), k + Math.floor(travelled / gap));
      }
    };
    // Faint, so they read as distance behind the bricks rather than more bricks.
    ctx.fillStyle = rgba(HILL, 0.42);
    scenery(0.5, tile * 13, (x, k) => {
      const steps = k % 2 ? 3 : 5;
      for (let s = 0; s < steps; s += 1) ctx.fillRect(x + s * tile, ground - (s + 1) * tile, (2 * (steps - s) - 1) * tile, tile);
    });
    // Sky blue rather than white, so they show on the light theme too.
    ctx.fillStyle = "rgba(120, 190, 255, 0.6)";
    scenery(0.2, tile * 17, (x, k) => {
      pixels(ctx, CLOUD, x, Math.round(-cover.y + tile * (1.5 + (((k % 3) + 3) % 3) * 1.2)), Math.round(tile / 2));
    });
  }

  // Columns that peak beside each other read as one platform.
  const stacks: [number, number][][] = Array.from({ length: 6 }, () => []);
  const floating: [number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    const fromCentre = count > 1 ? Math.abs((2 * i) / (count - 1) - 1) : 0;
    const level = Math.pow(Math.max(0, (binAt(freq, 1 - fromCentre) - 0.15) / 0.85), 1.2);
    const easing = 1 - Math.pow(1 - (level > state.heights[i] ? 0.5 : 0.12), dt / (1000 / 60));
    state.heights[i] += (level - state.heights[i]) * easing;
    const x = start + i * tile;
    const blocks = Math.round(state.heights[i] * most * grow);
    if (blocks >= 2 && state.heights[i] > state.peaks[i] + 0.12 && state.coins.length < 24) {
      state.coins.push({ x, y: ground - (blocks + 1) * tile, age: 0 });
    }
    state.peaks[i] = Math.max(state.heights[i], state.peaks[i] - dt * 0.00012);
    const band = Math.min(5, Math.floor((i / count) * 6));
    for (let b = 0; b < blocks; b += 1) stacks[band].push([x, ground - (b + 1) * tile]);
    const peak = Math.round(state.peaks[i] * most * grow);
    if (peak > blocks + 1) floating.push([x, ground - peak * tile]);
  }
  stacks.forEach((tiles, band) => bricks(ctx, paletteAt(phase + band / 6), tiles, tile));

  const m = mortar(tile);
  ctx.fillStyle = rgba(GOLD, 1);
  floating.forEach(([x, y]) => ctx.fillRect(x, y, tile, tile));
  ctx.fillStyle = rgba(shade(GOLD, -0.6), 1);
  floating.forEach(([x, y]) => {
    ctx.fillRect(x, y + tile - m, tile, m);
    ctx.fillRect(x + tile - m, y, m, tile);
    pixels(ctx, QUESTION, x, y + m, tile / 8);
  });

  const groundTiles: [number, number][] = [];
  for (let x = start + along(1, tile) - tile; x < right; x += tile) {
    for (let y = ground; y < floor; y += tile) groundTiles.push([Math.round(x), y]);
  }
  bricks(ctx, GROUND, groundTiles, tile);

  state.coins = state.coins.filter((coin) => (coin.age += dt) < 620);
  state.coins.forEach((coin) => {
    const t = coin.age / 620;
    const y = coin.y - tile * 2.4 * Math.sin(t * Math.PI * 0.75);
    const spin = Math.abs(Math.cos(coin.age / 80));
    const width = Math.max(m, Math.round(tile * 0.55 * spin));
    ctx.fillStyle = rgba([255, 214, 64], t > 0.6 ? (1 - t) / 0.4 : 1);
    ctx.fillRect(Math.round(coin.x + (tile - width) / 2), Math.round(y), width, Math.round(tile * 0.8));
  });

  if (staged) {
    // The level fades out at the stage's sides rather than stopping mid-cloud.
    const k = Math.min(0.2, (tile * 3) / (right - left));
    const sides = ctx.createLinearGradient(left, 0, right, 0);
    sides.addColorStop(0, "#000");
    sides.addColorStop(k, "rgba(0, 0, 0, 0)");
    sides.addColorStop(1 - k, "rgba(0, 0, 0, 0)");
    sides.addColorStop(1, "#000");
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = sides;
    // Only the two bands change anything; between them the gradient is clear.
    const band = k * (right - left);
    ctx.fillRect(left, -cover.y, band, cover.height);
    ctx.fillRect(right - band, -cover.y, band, cover.height);
  }
  ctx.restore();
}

type BloomState = { bands: [number, number, number]; spin: number };
const bloomState = (spin = 0): BloomState => ({ bands: [0, 0, 0], spin });

/**
 * Three glows, one each for the lows, the middle and the highs of the voice,
 * slowly circling the cover and swelling with their band. Radial washes, not
 * blurs: a blur this wide would cost every frame on a modest machine.
 */
function drawBloom({ ctx, cover, freq, phase, grow, pace }: Frame, state: BloomState, dt: number) {
  const levels = [bandLevel(freq, 0, 0.3), bandLevel(freq, 0.3, 0.65), bandLevel(freq, 0.65, 1)];
  levels.forEach((level, i) => {
    const lifted = Math.min(1, Math.max(0, (level - 0.12) * 2.2));
    // Ease in fast and out slowly so they breathe with phrases, not syllables.
    const easing = 1 - Math.pow(1 - (lifted > state.bands[i] ? 0.22 : 0.05), dt / (1000 / 60));
    state.bands[i] += (lifted - state.bands[i]) * easing;
  });
  state.spin += dt * pace * 0.00018;

  const { w, h, r } = cover;
  ctx.save();
  if (!cover.staged) {
    // Over the cover beside the controls, so keep the cover itself clear.
    ctx.beginPath();
    ctx.rect(-cover.x, -cover.y, cover.width, cover.height);
    ctx.roundRect(0, 0, w, h, r);
    ctx.clip("evenodd");
  }
  const half = Math.max(w, h) / 2;
  state.bands.forEach((energy, i) => {
    const angle = state.spin * (i % 2 ? -1 : 1) + (i * Math.PI * 2) / 3;
    // On the stage, far enough apart that each colour keeps a side of its
    // own rather than all three mixing to brown in the middle. Beside the
    // controls there is only a thin margin, so they hug the cover.
    const drift = Math.min(w, h) * (cover.staged ? 0.4 : 0.06);
    const inner = cover.staged ? Math.min(w, h) * 0.25 : half * 0.9;
    const cx = w / 2 + Math.cos(angle) * drift;
    const cy = h / 2 + Math.sin(angle) * drift;
    // Fade out before the canvas's edge, or the wash ends in a hard line.
    const room = Math.min(cx + cover.x, cover.width - cover.x - cx, cy + cover.y, cover.height - cover.y - cy);
    const outer = Math.min(room, (half * 0.7 + cover.reach * (0.45 + 0.9 * energy)) * (0.6 + 0.4 * grow));
    if (outer <= inner) return;
    const color = paletteAt(phase + [0, 0.22, 0.68][i]);
    const wash = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    wash.addColorStop(0, rgba(color, 0.4 + 0.5 * energy));
    wash.addColorStop(0.5, rgba(color, 0.16 + 0.3 * energy));
    wash.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = wash;
    // Only the wash's own square: past `outer` it is clear anyway.
    ctx.fillRect(cx - outer, cy - outer, outer * 2, outer * 2);
  });
  ctx.restore();
}

/**
 * Draws the playing audio around or over the player's cover, with the
 * switches that cycle the styles and open the stage sitting on the cover's
 * corner. Staged, the drawing fills the artwork area behind a smaller cover,
 * with the switches in the stage's corner.
 *
 * It only animates while the book is playing, at no more than `FRAME`. Paused,
 * the canvas is cleared, or on the stage settles to a faint still picture, and
 * is then left alone.
 * `analyser` is asked every frame because the player swaps its <audio>, and
 * with it the routed source, on every track change.
 */
export type PlayerVisualizerProps = {
  active: boolean;
  analyser: () => AnalyserNode | null;
  isPlaying: boolean;
  mode: Mode;
  onChange: (mode: Mode) => void;
  onStage: (staged: boolean) => void;
  staged: boolean;
  /** Shown but disabled, so a Safari listener learns why nothing happens. */
  unavailable: boolean;
};

export function PlayerVisualizer({
  active,
  analyser,
  isPlaying,
  mode,
  onChange,
  onStage,
  staged,
  unavailable
}: PlayerVisualizerProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const coverRef = useRef<Cover | null>(null);
  const live = !unavailable && mode !== "off";
  // Bloom needs the stage's open space; beside the controls it is the Halo
  // until the stage opens again.
  const style: Mode = mode === "bloom" && !staged ? "halo" : mode;
  // The draw loop and the key handler outlive renders, so they read the
  // latest of these through refs rather than re-subscribing each time.
  const analyserRef = useRef(analyser);
  analyserRef.current = analyser;
  const onStageRef = useRef(onStage);
  onStageRef.current = onStage;
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;
  const activeRef = useRef(active);
  activeRef.current = active;
  const wantedRef = useRef<Mode>("off");
  wantedRef.current = live ? style : "off";
  const wakeRef = useRef(() => {});

  // The cover is sized by the player's layout, so follow it rather than size it.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    const parent = frame?.parentElement;
    if (!frame || !parent) return;
    const place = () => {
      const element = parent.querySelector<HTMLElement>(".large-cover");
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const parentBounds = parent.getBoundingClientRect();
      const w = bounds.width;
      const h = bounds.height;
      const coverLeft = bounds.left - parentBounds.left;
      const coverTop = bounds.top - parentBounds.top;
      const r = Math.min(w / 2, h / 2, parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0);
      Object.assign(frame.style, {
        left: `${staged ? 0 : coverLeft}px`,
        top: `${staged ? 0 : coverTop}px`,
        width: `${staged ? parentBounds.width : w}px`,
        height: `${staged ? parentBounds.height : h}px`
      });
      if (!canvas) return;
      const left = staged ? 0 : coverLeft - BLEED;
      const top = staged ? 0 : coverTop - BLEED;
      const width = staged ? parentBounds.width : w + 2 * BLEED;
      const height = staged ? parentBounds.height : h + 2 * BLEED;
      const x = coverLeft - left;
      const y = coverTop - top;
      const reach = staged
        ? Math.max(BLEED, Math.min(STAGE_REACH, x, y, width - x - w, height - y - h))
        : BLEED;
      Object.assign(canvas.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      coverRef.current = { x, y, w, h, r, width, height, reach, staged, halo: outline(w, h, r, Math.round((2 * (w + h)) / HALO_SPACING)) };
      wakeRef.current();
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(parent);
    const cover = parent.querySelector(".large-cover");
    if (cover) observer.observe(cover);
    return () => observer.disconnect();
  }, [unavailable, staged]);

  useEffect(() => {
    if (!staged || !active) return;
    const collapse = (event: KeyboardEvent) => {
      // A sheet open over the player claims Escape for itself.
      if (event.key !== "Escape" || document.querySelector("[aria-modal='true']")) return;
      onStageRef.current(false);
    };
    window.addEventListener("keydown", collapse);
    return () => window.removeEventListener("keydown", collapse);
  }, [active, staged]);

  // One loop draws every style and carries the fades between them: in when
  // a style starts, playback resumes or the stage opens or closes, out on
  // pause or when switched off, and out-then-in when switching. Once faded
  // out, or settled to its resting picture, it stops, so a paused player
  // costs nothing.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = true;
    let blocks = blocksState();
    let bloom = bloomState();
    let freq = new Uint8Array(0);
    let shown: Mode = "off";
    let shownStaged: boolean | null = null;
    let alpha = 0;
    let pace = 0;
    let dpr = 0;
    let last = 0;
    let frame = 0;
    let elapsed = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
    };
    const draw = (now: number) => {
      frame = 0;
      if (document.hidden || !visible) {
        last = 0;
        return;
      }
      if (last && now - last < FRAME - 1) {
        frame = requestAnimationFrame(draw);
        return;
      }
      const cover = coverRef.current;
      if (cover) {
        const scale = Math.min(2, window.devicePixelRatio || 1);
        if (canvas.width !== Math.round(cover.width * scale) || canvas.height !== Math.round(cover.height * scale) || dpr !== scale) {
          dpr = scale;
          canvas.width = Math.round(cover.width * scale);
          canvas.height = Math.round(cover.height * scale);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, cover.width, cover.height);
      }
      if (!activeRef.current) {
        // Behind the library, or beside the reader, nothing is drawn, and a
        // frame left mid-motion would sit there frozen. Fade in afresh on return.
        alpha = 0;
        last = 0;
        return;
      }
      const still = motion.matches;
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      const playing = playingRef.current;
      const wanted = wantedRef.current;
      const target = wanted === "off" ? 0 : playing ? 1 : cover?.staged ? REST : 0;
      // The stage reshapes the whole drawing, so rather than morph from the
      // old one it starts afresh, once the cover has moved to its new place
      // (see `data-visualizer-transition` in styles.css).
      if (cover && cover.staged !== shownStaged) {
        if (shownStaged !== null) alpha = 0;
        shownStaged = cover.staged;
      }
      const morphing = document.documentElement.dataset.visualizerTransition !== undefined;
      pace = still ? Number(playing) : Math.min(1, Math.max(0, pace + (playing ? dt : -dt) / SETTLE));
      if (!still) elapsed += dt * pace;
      if (shown !== wanted && alpha > 0 && !still) {
        alpha = Math.max(0, alpha - dt / FADE_OUT);
      } else {
        if (shown !== wanted) {
          shown = wanted;
          blocks = blocksState(blocks.scroll);
          bloom = bloomState(bloom.spin);
        }
        alpha = still
          ? target
          : target > alpha
            ? morphing ? alpha : Math.min(target, alpha + dt / FADE_IN)
            : Math.max(target, alpha - dt / (target ? SETTLE : FADE_OUT));
      }
      if (alpha === 0 && target === 0 && shown === wanted) {
        last = 0;
        return;
      }
      // Draw this frame, and keep going unless it is the settled resting picture.
      if (!still && (playing || alpha !== target || pace > 0 || shown !== wanted)) frame = requestAnimationFrame(draw);
      else last = 0;
      const node = analyserRef.current();
      if (!cover || !cover.w || !node || shown === "off") return;
      if (freq.length !== node.frequencyBinCount) freq = new Uint8Array(node.frequencyBinCount);
      if (playing) node.getByteFrequencyData(freq);
      else {
        // The player suspends its audio on pause, which leaves the analyser
        // holding the last moment of speech. Let it die away to the resting
        // picture instead, or go straight there when motion is reduced.
        const keep = still ? 0 : Math.pow(0.5, dt / 90);
        for (let i = 0; i < freq.length; i += 1) freq[i] *= keep;
      }
      const grow = alpha * alpha * (3 - 2 * alpha);
      ctx.globalAlpha = grow;
      ctx.translate(cover.x, cover.y);
      // The palette turns once every minute or so.
      const scene: Frame = { ctx, cover, freq, phase: elapsed / 64000, grow, pace };
      if (shown === "halo") drawHalo(scene);
      else if (shown === "blocks") drawBlocks(scene, blocks, dt);
      else drawBloom(scene, bloom, dt);
    };
    wakeRef.current = () => {
      if (!frame && !document.hidden && visible) frame = requestAnimationFrame(draw);
    };
    const visibility = () => {
      if (document.hidden) stop();
      else wakeRef.current();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (!visible) stop();
      else wakeRef.current();
    });
    observer.observe(canvas.parentElement!);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("resize", wakeRef.current);
    motion.addEventListener("change", wakeRef.current);
    wakeRef.current();
    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("resize", wakeRef.current);
      motion.removeEventListener("change", wakeRef.current);
      wakeRef.current = () => {};
    };
  }, [unavailable]);

  useEffect(() => {
    wakeRef.current();
  }, [active, isPlaying, live, style, staged]);

  // On the stage the switch only changes style: Off would close the stage,
  // which is the shrink button's job. Beside the controls it skips Bloom.
  const cycle = PLAYER_VISUALIZERS.filter((option) => (staged ? option !== "off" : option !== "bloom"));
  const next = cycle[(cycle.indexOf(style) + 1) % cycle.length];
  const nextLabel = next === "off" ? "Off" : LABELS[next];
  return (
    <>
      {unavailable ? null : <canvas ref={canvasRef} className="player-visualizer-canvas" aria-hidden="true" />}
      <div ref={frameRef} className="player-visualizer-frame">
        <div className="player-visualizer-switches">
          {live ? (
            <button
              type="button"
              className="player-visualizer-toggle is-on"
              aria-label={staged ? "Shrink visualizer" : "Expand visualizer"}
              aria-expanded={staged}
              title={staged ? "Shrink (Esc)" : "Expand"}
              onClick={() => onStage(!staged)}
            >
              {staged ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          ) : null}
          <button
            type="button"
            className={`player-visualizer-toggle${live ? " is-on" : ""}`}
            disabled={unavailable}
            aria-label={unavailable
              ? "Visualizer is not available in Safari or iOS browsers"
              : mode === "off" ? "Turn on visualizer" : `Visualizer: ${LABELS[style]}. Next: ${nextLabel}`}
            title={unavailable ? "Not available in Safari or iOS browsers" : mode === "off" ? "Visualizer" : `Next: ${nextLabel}`}
            onClick={() => onChange(next)}
          >
            <AudioLines size={14} />
            <span>{unavailable ? "Not in Safari" : LABELS[style]}</span>
          </button>
        </div>
      </div>
    </>
  );
}
