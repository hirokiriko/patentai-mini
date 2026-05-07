import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // postinstall がコピーする pdfjs-dist の本体・assets。サードパーティのバンドル済み
    // コードなので lint の対象から外す（本番 Lambda 同梱のため repo に置いている）。
    "vendor/**",
  ]),
]);

export default eslintConfig;
