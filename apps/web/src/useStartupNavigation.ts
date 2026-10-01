import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { NativeTab } from "./nativeTabs";

/** Automatic restoration yields permanently to navigation in this mount. */
export function useStartupNavigation() {
  const [nativeTab, setStartupTab] = useState<NativeTab>("shelf");
  const startupNavigationOverridden = useRef(false);
  const setNativeTab: Dispatch<SetStateAction<NativeTab>> = useCallback((tab) => {
    // Mark even a re-tap of Shelf before React processes queued library state.
    startupNavigationOverridden.current = true;
    setStartupTab(tab);
  }, []);
  return { nativeTab, setNativeTab, setStartupTab, startupNavigationOverridden };
}
