import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { markNativePlatform, syncStatusBarStyle } from "./native";
import { applyStoredRotationLock } from "./rotationLock";
import { applyStoredAppearance, readStoredAppearanceMode, watchSystemAppearance } from "./appearance";
import "./styles.css";

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
