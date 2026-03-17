import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import router from "./router";
import ErrorBoundary from "./components/ErrorBoundary";
import { ToastProvider, useToast } from "./components/Toast";
import { setToastFn } from "./stores/uiStore";
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

// Bridge: wires the React toast context to the global toast function
function ToastBridge({ children }) {
  const addToast = useToast();
  useEffect(() => {
    setToastFn(addToast);
  }, [addToast]);
  return children;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <ToastProvider>
      <ToastBridge>
        <RouterProvider router={router} />
      </ToastBridge>
    </ToastProvider>
  </ErrorBoundary>,
);
