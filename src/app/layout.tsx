import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Patent Prior-Art Check",
  description: "特許先行技術調査 PoC",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <aside
          aria-label="試用版の利用範囲"
          className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          <p className="mx-auto max-w-5xl">
            公開公報・完全架空データを対象とした試用版です。
            未公開発明・顧客資料・個人情報を入力・アップロードしないでください。
            結果は調査支援であり、人による確認が必要です。
          </p>
        </aside>
        {children}
        <footer className="px-4 py-4 text-sm text-gray-600"><a href="/.auth/logout">ログアウト</a></footer>
      </body>
    </html>
  );
}
