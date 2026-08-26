import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Workspace packages are consumed as TypeScript source rather than built
  // output, so a change in the engine is reflected immediately without a build
  // step. Vite transpiles them like any other source file.
  optimizeDeps: {
    exclude: ["@sds/core", "@sds/schema", "@sds/analytic"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
});
