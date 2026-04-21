import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist は Node 環境で cmaps/standard_fonts を直接 fs で読むため
  // バンドルせず外部パッケージとして扱う。@napi-rs/canvas は pdfjs-dist が
  // DOMMatrix 等の polyfill のため require するので同じ扱いにする
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  // pnpm の node_modules は symlink のため、そのまま
  // outputFileTracingIncludes に指定すると Vercel で
  // "invalid deployment package" エラーになる。
  // postinstall で vendor/pdfjs-dist に実ファイルを複製している
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./vendor/pdfjs-dist/cmaps/**",
      "./vendor/pdfjs-dist/standard_fonts/**",
    ],
  },
};

export default nextConfig;
