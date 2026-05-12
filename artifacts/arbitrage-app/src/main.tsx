import { createRoot } from "react-dom/client";
import { setBotSecretGetter } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

setBotSecretGetter(() => {
  try { return localStorage.getItem("bot_secret"); } catch { return null; }
});

const savedTheme = localStorage.getItem("theme");
const isDark =
  savedTheme === "dark" ||
  (savedTheme !== "light" && !window.matchMedia("(prefers-color-scheme: light)").matches);
if (isDark) {
  document.documentElement.classList.add("dark");
} else {
  document.documentElement.classList.remove("dark");
}

createRoot(document.getElementById("root")!).render(<App />);
