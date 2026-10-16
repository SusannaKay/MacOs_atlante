// Costruisce l'interfaccia in dist/ (JS, CSS, font, HTML).
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "fs";

mkdirSync("dist", { recursive: true });
await esbuild.build({
  entryPoints: { app: "src/app.js", styles: "src/styles.css" },
  bundle: true,
  outdir: "dist",
  format: "iife",
  target: ["chrome130"],
  minify: process.env.DEV ? false : true,
  sourcemap: true,
  loader: { ".woff2": "file", ".woff": "file" },
  assetNames: "fonts/[name]-[hash]",
  logLevel: "info",
});
copyFileSync("src/index.html", "dist/index.html");
