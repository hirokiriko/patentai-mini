import Link from "next/link";
import { requireOwner } from "@/lib/owner-http";
import { KohoUploadForm } from "./upload-form";
export const dynamic = "force-dynamic";
export default async function KohoUpdatesPage() {
  await requireOwner();
  return <main className="mx-auto w-full max-w-3xl px-4 py-8">
    <Link href="/" className="text-blue-700 underline">案件一覧へ戻る</Link>
    <h1 className="mt-5 text-2xl font-bold">公報データの更新</h1>
    <p className="mt-3 text-gray-700">正規取得済みの差分公報ZIPを1ファイルずつ選択してください。保存内容を確認してから取り込みます。</p>
    <KohoUploadForm />
  </main>;
}
