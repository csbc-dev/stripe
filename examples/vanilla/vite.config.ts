import { defineConfig } from "vite";

export default defineConfig({
  // strictPort: fail loudly if 5175 is taken instead of silently sliding to the
  // next free port. The examples README pins each app to a fixed port so all
  // four can run side by side; a silent shift would break that contract.
  server: { port: 5175, strictPort: true },
});
