import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds the service worker (sw/sw.js) into dist/sw.js with this build's version and the list of
 * its files, so the installed app keeps exactly the files of the version it runs.
 */
function serviceWorker(): Plugin {
  return {
    name: "fantasytool-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = ["/", ...Object.keys(bundle).filter((name) => name.startsWith("assets/")).map((name) => `/${name}`)];
      const version = `${Date.now()}`;
      const source = readFileSync("sw/sw.js", "utf8")
        .replace('"__VERSION__"', JSON.stringify(version))
        .replace("__FILES__", JSON.stringify(files));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// The React dev server runs on 5173 and forwards /api calls to the
// local backend on 8787, so the browser never talks to Sleeper directly.
export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
    // The backend writes downloaded data here; it is not part of the app.
    watch: { ignored: ["**/.cache/**"] },
  },
});
