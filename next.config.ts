import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist は Node 環境で node_modules 内の cmaps/standard_fonts を
  // 直接 fs で読むため、バンドルせず外部パッケージとして扱う
  serverExternalPackages: ["pdfjs-dist"],
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
