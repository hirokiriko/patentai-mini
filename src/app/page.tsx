import Link from "next/link";
import { caseRepo } from "@/repositories";
import type { Case } from "@/repositories";
import { NewCaseForm } from "./new-case-form";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let rows: Case[] = [];
  let dbError = false;

  try {
    rows = await caseRepo.findAll();
  } catch {
    dbError = true;
  }

  if (dbError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-3xl font-bold mb-6">Patent Prior-Art Check</h1>
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 px-5 py-4 text-base text-yellow-800">
          <p className="font-medium">データベースに接続できません</p>
          <p className="mt-1">
            DATABASE_URL が未設定か、接続先が利用できません。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Patent Prior-Art Check</h1>

      <NewCaseForm />

      <section className="mt-8">
        <h2 className="text-xl font-bold mb-3">案件一覧</h2>
        {rows.length === 0 ? (
          <p className="text-base text-gray-600">
            まだ案件がありません。上のフォームから新しい案件を作成してください。
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((c) => (
              <li key={c.caseId}>
                <Link
                  href={`/cases/${c.caseId}`}
                  className="group flex items-center justify-between rounded-lg border-2 border-gray-200 px-5 py-4 transition-all hover:border-blue-300 hover:bg-blue-50 hover:shadow-sm"
                >
                  <div>
                    <span className="text-base font-medium group-hover:text-blue-700">
                      {c.title}
                    </span>
                    <span className="ml-3 text-sm text-gray-600">
                      {c.status}
                    </span>
                    <span className="ml-3 text-sm text-gray-600">
                      {c.createdAt}
                    </span>
                  </div>
                  <span className="text-gray-400 group-hover:text-blue-600 text-lg">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
