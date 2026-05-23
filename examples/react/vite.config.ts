import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // strictPort: fail loudly if 5173 is taken instead of silently sliding to the
  // next free port. The examples README pins each app to a fixed port so all
  // four can run side by side; a silent shift would break that contract.
  server: { port: 5173, strictPort: true },
});
