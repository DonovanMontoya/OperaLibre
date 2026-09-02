import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { markNativePlatform, syncStatusBarStyle } from "./native";
import { applyStoredRotationLock } from "./rotationLock";
import { applyStoredAppearance, readAppearanceMode, watchSystemAppearance } from "./appearance";
import "./styles.css";

// Merely touching window.localStorage throws when site data is blocked; the
// status bar just keeps the system appearance then.
function readStoredAppearanceMode() {
  try {
    return readAppearanceMode(window.localStorage);
  } catch {
    return "system" as const;
  }
}

markNativePlatform();
applyStoredAppearance();
watchSystemAppearance();
syncStatusBarStyle(readStoredAppearanceMode());
void applyStoredRotationLock().catch((error) => {
  console.warn("Could not restore the app rotation lock", error);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
