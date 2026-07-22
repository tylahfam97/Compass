import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Chromium/WebView2 sometimes reports a benign "ResizeObserver loop completed with
// undelivered notifications" error when a chart's container resizes (common with
// recharts' ResponsiveContainer, e.g. the Dashboard's account sparklines) - it's
// harmless, but left uncaught it can surface as a global error. Suppress just this
// specific message so it can never be mistaken for (or interact badly with) a real
// crash elsewhere in the app.
window.addEventListener("error", (e) => {
  if (e.message?.includes("ResizeObserver loop")) {
    e.stopImmediatePropagation();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
