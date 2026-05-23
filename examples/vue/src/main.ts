// Side-effect import FIRST: configures remote mode + the (mock) Stripe.js
// loader and registers <stripe-checkout> before Vue renders it.
import "./stripe-setup";
import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

createApp(App).mount("#app");
