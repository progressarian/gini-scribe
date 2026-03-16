import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import router from "./router";
import ErrorBoundary from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import "./styles/global.css";

// Global unhandled promise rejection handler
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection:", e.reason);
  e.preventDefault();
});

// Global error handler
window.addEventListener("error", (e) => {
  console.error("Uncaught error:", e.error);
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </ErrorBoundary>,
);
