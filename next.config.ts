import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @napi-rs/canvas は native binding を含むためバンドル不可。external
  // として扱い、parse-file.ts の side-effect import で output tracing に
  // 拾わせる。pdfjs-dist は vendor/ から動的 import するので external 指定
  // は不要。
  serverExternalPackages: ["@napi-rs/canvas"],
  // pnpm の node_modules は symlink のため、outputFileTracingIncludes に
  // ./node_modules/... を指定すると Vercel で invalid deployment package
  // エラーになる。postinstall で vendor/pdfjs-dist/ に必要ファイルを複製し、
  // そこを含める。
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./vendor/pdfjs-dist/cmaps/**",
      "./vendor/pdfjs-dist/standard_fonts/**",
      "./vendor/pdfjs-dist/legacy/build/**",
    ],
  },
};

export default nextConfig;
