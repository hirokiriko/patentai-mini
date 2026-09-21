export function ComparisonScopeNotice({ hasAiFindings }: { hasAiFindings: boolean }) {
  if (!hasAiFindings) return null;

  return (
    <aside aria-label="AI比較の範囲" className="break-inside-avoid space-y-2 rounded border border-slate-300 bg-slate-50 p-4 text-sm leading-6">
      <p className="font-semibold">AI比較の範囲</p>
      <p>
        分析がaiの候補について、現行の比較方法を説明しています。自案の独立請求項（独立請求項が抽出されていない場合は全請求項）と、公報の要約および請求項テキストの先頭最大2,000文字を比較します。明細書全文や請求項の残りは比較範囲に含みません。
      </p>
      <p>
        差分候補は入力範囲で一致を確認できない内容です。公報全体に記載がないという意味ではありません。Lowでも原文を確認してください。
      </p>
      <p>
        各結果の実際の入力文字数や切断の有無を示す記録ではありません。fallback候補はAI詳細比較の結果ではありません。
      </p>
    </aside>
  );
}
