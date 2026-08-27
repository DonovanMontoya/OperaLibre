import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { markNativePlatform } from "./native";
import { applyStoredRotationLock } from "./rotationLock";
import { applyStoredDarkMode } from "./appearance";
import "./styles.css";

markNativePlatform();
applyStoredDarkMode();
void applyStoredRotationLock().catch((error) => {
  console.warn("Could not restore the app rotation lock", error);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
