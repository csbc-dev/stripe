// Side-effect import FIRST: configures remote mode + the (mock) Stripe.js
// loader and registers <stripe-checkout> before React renders it.
import "./stripe-setup";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

createRoot(document.getElementById("root")!).render(<App />);
