import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [
    vue({
      template: {
        // Tell the Vue compiler <stripe-checkout> is a custom element, not a
        // Vue component, so it leaves attribute binding alone.
        compilerOptions: {
          isCustomElement: (tag) => tag === "stripe-checkout",
        },
      },
    }),
  ],
  // strictPort: fail loudly if 5174 is taken instead of silently sliding to the
  // next free port. The examples README pins each app to a fixed port so all
  // four can run side by side; a silent shift would break that contract.
  server: { port: 5174, strictPort: true },
});
