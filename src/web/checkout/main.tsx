import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Checkout } from "./Checkout";
import { ThemeToggle } from "./ThemeToggle";
import "./checkout.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeToggle />
    <Checkout />
  </StrictMode>
);
