import Link from "next/link";
import { db } from "@/db";
import { cases } from "@/db/schema";
import { desc } from "drizzle-orm";
import { NewCaseForm } from "./new-case-form";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const rows = await db.select().from(cases).orderBy(desc(cases.createdAt));

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Patent Prior-Art Check</h1>

      <NewCaseForm />

      <section className="mt-8">
        <h2 className="text-lg font-semibold mb-3">案件一覧</h2>
        {rows.length === 0 ? (
          <p className="text-gray-500">まだ案件がありません。</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((c) => (
              <li key={c.caseId}>
                <Link
                  href={`/cases/${c.caseId}`}
                  className="block rounded border border-gray-200 px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <span className="font-medium">{c.title}</span>
                  <span className="ml-3 text-sm text-gray-500">
                    {c.status}
                  </span>
                  <span className="ml-3 text-xs text-gray-400">
                    {c.createdAt}
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
