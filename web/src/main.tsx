import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { OverlayProvider } from "./components/Overlay";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OverlayProvider>
      <App />
    </OverlayProvider>
  </StrictMode>,
);
