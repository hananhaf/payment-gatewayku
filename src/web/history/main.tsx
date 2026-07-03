import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { History } from "./History";
import "../checkout/checkout.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <History />
  </StrictMode>
);
