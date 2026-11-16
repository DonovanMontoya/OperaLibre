import { useCallback, useEffect, useRef, useState } from "react";
import { PLAYBACK_SPEED_PRESETS } from "./playbackSpeed.ts";

/**
 * The pop-out player is a second window that shows the tab's own player. It
 * never loads the app: the audio, the clock and progress sync stay in the
 * tab, and the window only renders controls through a portal. Chrome and
 * Edge keep it above other windows (Document Picture-in-Picture); other
 * desktop browsers, and plain-HTTP addresses where that API is withheld, get
 * an ordinary popup.
 */
export type PopOutMode = "pip" | "window";

type DocumentPictureInPicture = {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
};

const POP_OUT_SIZE = { width: 320, height: 440 };
const POPUP_NAME = "operalibre-player";
// Stylesheets are already cached by the tab; this only bounds a slow one.
const STYLE_WAIT_MS = 1500;

function pictureInPicture(): DocumentPictureInPicture | null {
  return (window as Window & { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture ?? null;
}

export function popOutMode(native: boolean): PopOutMode | null {
  if (native || typeof window === "undefined") return null;
  if (pictureInPicture()) return "pip";
  // On a phone or tablet a popup is only another tab.
  return window.matchMedia?.("(pointer: fine)").matches ? "window" : null;
}

/** The next speed in the presets, wrapping to the slowest after the fastest. */
export function nextPresetSpeed(speed: number): number {
  return PLAYBACK_SPEED_PRESETS.find((preset) => preset > speed + 0.001) ?? PLAYBACK_SPEED_PRESETS[0];
}

export type PopOutKeyAction = "toggle" | "back" | "forward" | null;

/** Space and the arrow keys work anywhere in the window except where a
    control already answers them. */
export function popOutKeyAction(key: string, target: { tagName?: string } | null): PopOutKeyAction {
  const tag = target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return null;
  if (key === " ") return tag === "button" ? null : "toggle";
  if (key === "ArrowLeft") return "back";
  if (key === "ArrowRight") return "forward";
  return null;
}

/* The window starts blank; it takes the tab's stylesheets (fonts included,
   from the same origin) and the root's theme classes and attributes. */
function preparePopOutDocument(target: Window): { container: HTMLElement; styled: Promise<unknown> } {
  const doc = target.document;
  const root = document.documentElement;
  doc.documentElement.className = `${root.className} popout-document`.trim();
  for (const attribute of Array.from(root.attributes)) {
    if (attribute.name.startsWith("data-") || attribute.name === "lang") {
      doc.documentElement.setAttribute(attribute.name, attribute.value);
    }
  }
  doc.head.replaceChildren();
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  doc.head.append(charset);
  const loading: Promise<unknown>[] = [];
  for (const node of Array.from(document.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>("link[rel=stylesheet], style"))) {
    const copy = doc.importNode(node, true);
    if (node instanceof HTMLLinkElement) {
      copy.setAttribute("href", node.href);
      loading.push(new Promise((settle) => {
        copy.addEventListener("load", settle, { once: true });
        copy.addEventListener("error", settle, { once: true });
      }));
    }
    doc.head.append(copy);
  }
  // Dark from the first frame, before the stylesheets arrive.
  doc.body.style.background = getComputedStyle(root).getPropertyValue("--spine-deep") || "#0e0a07";
  doc.body.style.margin = "0";
  const container = doc.createElement("div");
  container.className = "popout-mount";
  doc.body.replaceChildren(container);
  const styled = Promise.race([
    Promise.all(loading),
    new Promise((settle) => window.setTimeout(settle, STYLE_WAIT_MS))
  ]);
  return { container, styled };
}

export type PopOutPlayerWindow = { window: Window; container: HTMLElement };

/** What a player button needs to open or close the pop-out. */
export type PopOutControl = { open: boolean; toggle: () => void };

export function usePopOutPlayer(native: boolean, hasBook: boolean) {
  const [mode] = useState(() => popOutMode(native));
  const [current, setCurrent] = useState<PopOutPlayerWindow | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  const attach = useCallback((target: Window) => {
    const { container, styled } = preparePopOutDocument(target);
    let closed = false;
    target.addEventListener("pagehide", () => {
      closed = true;
      setCurrent((open) => (open?.window === target ? null : open));
    }, { once: true });
    void styled.then(() => {
      if (!closed) setCurrent({ window: target, container });
    });
  }, []);

  // Both requests must start inside the click that asked for them, or the
  // browser refuses them as unrequested.
  const open = useCallback(() => {
    if (!mode) return;
    if (current) {
      current.window.focus();
      return;
    }
    if (mode === "pip") {
      pictureInPicture()?.requestWindow(POP_OUT_SIZE).then(attach, () => {});
      return;
    }
    const left = Math.max(0, window.screenX + window.outerWidth - POP_OUT_SIZE.width - 48);
    const top = Math.max(0, window.screenY + 96);
    const popup = window.open("", POPUP_NAME,
      `popup,width=${POP_OUT_SIZE.width},height=${POP_OUT_SIZE.height},left=${left},top=${top}`);
    if (popup) attach(popup);
  }, [attach, current, mode]);

  const close = useCallback(() => {
    currentRef.current?.window.close();
    setCurrent(null);
  }, []);

  // Nothing to show once the book stops; a popup also leaves with the tab
  // (Picture-in-Picture closes with it on its own).
  useEffect(() => {
    if (!hasBook) close();
  }, [close, hasBook]);
  useEffect(() => {
    if (!current) return;
    const closeWithTab = () => current.window.close();
    window.addEventListener("pagehide", closeWithTab);
    return () => window.removeEventListener("pagehide", closeWithTab);
  }, [current]);

  return {
    supported: mode !== null,
    current,
    open,
    close,
    toggle: current ? close : open
  };
}
