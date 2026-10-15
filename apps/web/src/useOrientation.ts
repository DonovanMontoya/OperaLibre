import { useEffect, useState } from "react";

export const LANDSCAPE_QUERY = "(orientation: landscape)";
// A phone on its side: short enough that the iPad spread never applies.
export const SHORT_LANDSCAPE_QUERY = "(orientation: landscape) and (max-height: 499px)";
function matchesQuery(query: string): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesQuery(query));
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function readLandscape(): boolean {
  return matchesQuery(LANDSCAPE_QUERY);
}

export function useLandscapeOrientation(): boolean {
  return useMediaQuery(LANDSCAPE_QUERY);
}

// A browser window wide enough to hold a book open: two pages, each still a
// comfortable measure. The web reader borrows the Duo's spread here.
const WIDE_SPREAD_QUERY = "(min-width: 1100px) and (orientation: landscape)";
export function useWideSpreadWindow(): boolean {
  return useMediaQuery(WIDE_SPREAD_QUERY);
}

// A browser window as narrow as a phone, where book details stack in one column.
const PHONE_WIDTH_QUERY = "(max-width: 620px)";
export function usePhoneWidthWindow(): boolean {
  return useMediaQuery(PHONE_WIDTH_QUERY);
}

export function readShortLandscape(): boolean {
  return matchesQuery(SHORT_LANDSCAPE_QUERY);
}

// How much of the web reading room fits: the page alone, the page beside its
// contents, or all three columns.
const ROOM_QUERY = "(min-width: 900px)";
const WIDE_ROOM_QUERY = "(min-width: 1240px)";
export type ReadingRoomWindow = "narrow" | "contents" | "wide";
function readReadingRoomWindow(): ReadingRoomWindow {
  if (typeof window === "undefined" || !window.matchMedia) return "wide";
  if (window.matchMedia(WIDE_ROOM_QUERY).matches) return "wide";
  return window.matchMedia(ROOM_QUERY).matches ? "contents" : "narrow";
}

export function useReadingRoomWindow(): ReadingRoomWindow {
  const [room, setRoom] = useState(readReadingRoomWindow);
  useEffect(() => {
    const queries = [window.matchMedia(ROOM_QUERY), window.matchMedia(WIDE_ROOM_QUERY)];
    const update = () => setRoom(readReadingRoomWindow());
    update();
    queries.forEach((query) => query.addEventListener("change", update));
    return () => queries.forEach((query) => query.removeEventListener("change", update));
  }, []);
  return room;
}
