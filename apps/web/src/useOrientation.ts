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

export function readShortLandscape(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(SHORT_LANDSCAPE_QUERY).matches;
}
