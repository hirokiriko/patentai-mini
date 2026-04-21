import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist は Node 環境で node_modules 内の cmaps/standard_fonts を
  // 直接 fs で読むため、バンドルせず外部パッケージとして扱う
  serverExternalPackages: ["pdfjs-dist"],
  // Vercel 等の serverless 環境では Lambda バンドルに node_modules の一部しか
  // 含まれないため、cmap/standard_fonts ディレクトリを明示的に追加する
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/pdfjs-dist/standard_fonts/**",
    ],
  },
};

export default nextConfig;
