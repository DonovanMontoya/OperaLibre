import "./schedulerHost";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { markNativePlatform, syncStatusBarStyle } from "./native";
import { installPressGuard } from "./pressGuard";
import { applyStoredRotationLock } from "./rotationLock";
import { applyStoredAppearance, readStoredAppearanceMode, watchSystemAppearance } from "./appearance";
import { applyStoredColorVision } from "./colorVision";
import "./styles.css";
import "./colorVision.css";

markNativePlatform();
installPressGuard();
applyStoredAppearance();
applyStoredColorVision();
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
