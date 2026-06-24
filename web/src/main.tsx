import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LoginGate } from "./components/LoginGate";
import { OverlayProvider } from "./components/Overlay";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OverlayProvider>
      <LoginGate>
        <App />
      </LoginGate>
    </OverlayProvider>
  </StrictMode>,
);
