import type { UserConfig } from "vite";
import { defineConfig } from "vite";
import devServerPathMapPlugin from "./build_tools/vite/vite-plugin-dev-server-path-map.js";

// Ensure that the Google oauth2 and bossDB auth redirect pages have the
// expected names, as otherwise authentication requests will fail.
const AUTH_REDIRECT_HTML = new Map([
  ["/google_oauth2_redirect.html", "/src/util/google_oauth2_redirect.html"],
  ["/bossauth.html", "/src/datasource/boss/bossauth.html"],
]);

export default defineConfig(
  ({ mode }): UserConfig => ({
    define: {
      // This is the default client ID used for the hosted neuroglancer.
      // In addition to the hosted neuroglancer origin, it is valid for
      // the origins:
      //
      //   localhost:8000
      //   127.0.0.1:8000
      //   localhost:8080
      //   127.0.0.1:8080
      //
      // To deploy to a different origin, you will need to generate your
      // own client ID from on the Google Developer Console and substitute
      // it in.
      NEUROGLANCER_BRAINMAPS_CLIENT_ID: JSON.stringify(
        "639403125587-4k5hgdfumtrvur8v48e3pr7oo91d765k.apps.googleusercontent.com",
      ),

      // NEUROGLANCER_CREDIT_LINK: JSON.stringify({url: '...', text: '...'}),
      // NEUROGLANCER_DEFAULT_STATE_FRAGMENT: JSON.stringify('gs://bucket/state.json'),
      // NEUROGLANCER_SHOW_LAYER_BAR_EXTRA_BUTTONS: true,
      // NEUROGLANCER_SHOW_OBJECT_SELECTION_TOOLTIP: true

      // NEUROGLANCER_GOOGLE_TAG_MANAGER: JSON.stringify('GTM-XXXXXX'),
    },

    // Use relative URLs to reference other files, in order to allow built assets
    // to be served from any path.
    base: "",
    // Prevent *.html redirecting to `index.html` on dev server, to avoid confusion.
    appType: "mpa",
    optimizeDeps: {
      include: ["nifti-reader-js", "pako", "numcodecs/blosc", "numcodecs/zstd"],
    },
    plugins: [
      devServerPathMapPlugin({
        map: AUTH_REDIRECT_HTML,
      }),
    ],
    build: {
      outDir: mode === "development" ? "dist/dev" : "dist/min",
      chunkSizeWarningLimit: 2 * 1024 * 1024,
      assetsDir: "",
      rollupOptions: {
        output: {
          format: "esm",
          assetFileNames: (assetInfo) => {
            const { name } = assetInfo;
            if (name !== undefined && AUTH_REDIRECT_HTML.has(`/${name}`)) {
              return "[name][extname]";
            }
            return "[name]-[hash][extname]";
          },
        },
      },
    },
    worker: {
      format: "es",
    },
    server: {
      port: 8080,
    },
  }),
);
