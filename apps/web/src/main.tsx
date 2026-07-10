import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { markNativePlatform } from "./native";
import "./styles.css";

markNativePlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
