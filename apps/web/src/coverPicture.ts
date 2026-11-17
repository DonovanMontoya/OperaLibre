import { mediaUrl } from "./api";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { getOfflineCoverUrl, releaseOfflineMediaUrl } from "./offline";
import type { Book } from "./types";

export type CoverPicture = {
  bookId: string | null;
  title: string;
  /** A square copy of the cover, kept so the puzzle works offline too. */
  image: string;
};

// Large enough for crisp tiles on an iPad board, small enough to save.
const IMAGE_SIZE = 480;

export function bookHasCover(book: Book): boolean {
  return !!book.coverArtUrl || !!book.localCoverPath;
}

async function coverSources(book: Book): Promise<string[]> {
  const sources: string[] = [];
  // A cover already on this device works offline and never touches the server.
  const local = await getOfflineCoverUrl(book, true).catch(() => null);
  if (local) sources.push(local);
  if (book.coverArtUrl) sources.push(mediaUrl(book.coverArtUrl));
  return sources;
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Cover did not load"));
    image.src = source;
  });
}

/**
 * Reads the cover's pixels. It is fetched into a blob first: a canvas drawn
 * from a cross-origin image (a remote server, a native file URL) refuses to
 * give its pixels back, while a blob URL is always this page's own.
 */
async function coverImage(source: string, signal: AbortSignal): Promise<HTMLImageElement> {
  const blob = await fetchWithTimeout(source, { signal }, async (response) => {
    if (!response.ok) throw new Error(`Cover request failed (${response.status})`);
    return response.blob();
  }, 5000);
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawSquare(image: HTMLImageElement, size: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // Audiobook art is square, but a print cover is not: take the centre.
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  context.imageSmoothingQuality = "high";
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
  return context;
}

export async function makeCoverPicture(book: Book, signal: AbortSignal): Promise<CoverPicture | null> {
  for (const source of await coverSources(book)) {
    try {
      const square = drawSquare(await coverImage(source, signal), IMAGE_SIZE);
      if (!square) return null;
      return { bookId: book.id, title: book.title, image: square.canvas.toDataURL("image/jpeg", 0.82) };
    } catch (error) {
      if (signal.aborted) throw error;
    } finally {
      releaseOfflineMediaUrl(source);
    }
  }
  return null;
}

/**
 * A plate of our own for a library with no readable covers: a bound board
 * with a ruled frame and lettering, so every tile has something to place.
 */
export function fallbackPicture(): CoverPicture {
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const context = canvas.getContext("2d")!;
  const side = IMAGE_SIZE;
  const cloth = context.createLinearGradient(0, 0, side, side);
  cloth.addColorStop(0, "#7d2f2a");
  cloth.addColorStop(1, "#3d1512");
  context.fillStyle = cloth;
  context.fillRect(0, 0, side, side);
  context.strokeStyle = "#d9b574";
  context.lineWidth = 6;
  context.strokeRect(28, 28, side - 56, side - 56);
  context.lineWidth = 2;
  context.strokeRect(44, 44, side - 88, side - 88);
  for (const [x, y] of [[44, 44], [side - 44, 44], [44, side - 44], [side - 44, side - 44]]) {
    context.beginPath();
    context.arc(x, y, 14, 0, Math.PI * 2);
    context.fillStyle = "#d9b574";
    context.fill();
  }
  context.fillStyle = "#f0dcae";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "600 150px Fraunces, Georgia, serif";
  context.fillText("O", side / 2, side * 0.38);
  context.font = "600 56px Fraunces, Georgia, serif";
  context.fillText("OperaLibre", side / 2, side * 0.66);
  context.font = "italic 28px Fraunces, Georgia, serif";
  context.fillText("the parlour edition", side / 2, side * 0.78);
  return { bookId: null, title: "The parlour plate", image: canvas.toDataURL("image/jpeg", 0.82) };
}
