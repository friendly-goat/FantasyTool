import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React dev server runs on 5173 and forwards /api calls to the
// local backend on 8787, so the browser never talks to Sleeper directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
    // The backend writes downloaded data here; it is not part of the app.
    watch: { ignored: ["**/.cache/**"] },
  },
});
