import { useEffect, useState } from "react";

export const LANDSCAPE_QUERY = "(orientation: landscape)";
// A phone on its side: short enough that the iPad spread never applies.
export const SHORT_LANDSCAPE_QUERY = "(orientation: landscape) and (max-height: 499px)";
export function readLandscape(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(LANDSCAPE_QUERY).matches;
}

export function useLandscapeOrientation(): boolean {
  const [landscape, setLandscape] = useState(readLandscape);
  useEffect(() => {
    const query = window.matchMedia(LANDSCAPE_QUERY);
    const update = () => setLandscape(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return landscape;
}

// A browser window wide enough to hold a book open: two pages, each still a
// comfortable measure. The web reader borrows the Duo's spread here.
const WIDE_SPREAD_QUERY = "(min-width: 1100px) and (orientation: landscape)";
export function useWideSpreadWindow(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(WIDE_SPREAD_QUERY).matches
  );
  useEffect(() => {
    const query = window.matchMedia(WIDE_SPREAD_QUERY);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

// A browser window as narrow as a phone, where book details stack in one column.
const PHONE_WIDTH_QUERY = "(max-width: 620px)";
export function usePhoneWidthWindow(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(PHONE_WIDTH_QUERY).matches
  );
  useEffect(() => {
    const query = window.matchMedia(PHONE_WIDTH_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

export function readShortLandscape(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(SHORT_LANDSCAPE_QUERY).matches;
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
