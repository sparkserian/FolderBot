import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initialize } from "./store";
import "./styles.css";

document.documentElement.dataset.platform = window.folderBot?.platform ?? "web";

const root = document.getElementById("app");
if (!root) {
  throw new Error("App root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

void initialize();
