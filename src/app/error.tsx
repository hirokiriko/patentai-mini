"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-12">
      <div className="rounded-lg border border-red-200 bg-red-50 px-5 py-4">
        <p className="text-sm font-medium text-red-700">画面表示中にエラーが発生しました</p>
        <h1 className="mt-2 text-2xl font-bold text-red-950">
          もう一度読み込んでください
        </h1>
        <p className="mt-2 text-base text-red-900">
          一時的な通信エラー、または処理中データの読み込み失敗の可能性があります。
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-red-700">digest: {error.digest}</p>
        )}
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded bg-red-700 px-4 py-2 text-base font-medium text-white hover:bg-red-800"
        >
          再読み込み
        </button>
      </div>
    </main>
  );
}
