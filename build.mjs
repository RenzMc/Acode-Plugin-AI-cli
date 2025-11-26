import * as esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { exec } from "child_process";

(async () => {
  await esbuild.build({
    entryPoints: ["src/main.js"],
    bundle: true,
    minify: true,
    logLevel: "info",
    color: true,
    outdir: "dist",
    plugins: [
      sassPlugin({
        type: "css-text",
      }),
    ],
  });

  exec("node .acode/pack-zip.js", (err, stdout, stderr) => {
    if (err) return console.error(err);
    console.log(stdout);
  });
})();