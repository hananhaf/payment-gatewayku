import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { History } from "./History";
import { ThemeToggle } from "../checkout/ThemeToggle";
import "../checkout/checkout.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeToggle />
    <History />
  </StrictMode>
);
