import { useEffect, useState } from "react";
import { COLOR_VISION_OPTIONS } from "./colorVision";

function currentColorVision() {
  const root = document.documentElement;
  return {
    mode: COLOR_VISION_OPTIONS.find(({ id }) => id === root.getAttribute("data-color-vision"))?.id ?? "default",
    strongerCues: root.hasAttribute("data-stronger-cues")
  };
}

export function useColorVision() {
  const [settings, setSettings] = useState(currentColorVision);
  useEffect(() => {
    const observer = new MutationObserver(() => setSettings(currentColorVision()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-vision", "data-stronger-cues"] });
    return () => observer.disconnect();
  }, []);
  return settings;
}
