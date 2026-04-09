export function JplatpatGuide() {
  return (
    <div
      id="step-3-guide"
      className="scroll-mt-36 rounded-xl border-2 border-amber-200 bg-amber-50 px-6 py-5"
    >
      <h3 className="text-lg font-bold text-amber-900">
        J-PlatPat で検索する手順
      </h3>

      <ol className="mt-4 list-none space-y-4 text-base text-amber-900">
        <li className="flex gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-200 text-sm font-bold text-amber-800">
            1
          </span>
          <span>
            下記のリンクから J-PlatPat を開きます（新しいタブで開きます）
            <br />
            <a
              href="https://www.j-platpat.inpit.go.jp/"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block font-bold text-blue-700 underline"
            >
              https://www.j-platpat.inpit.go.jp/
            </a>
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-200 text-sm font-bold text-amber-800">
            2
          </span>
          <span>
            「特許・実用新案」→「特許・実用新案検索」を選択します
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-200 text-sm font-bold text-amber-800">
            3
          </span>
          <span>
            上の検索式をコピーして、検索欄に貼り付けて検索します
            <br />
            <span className="text-sm text-amber-700">
              まず「中庸（バランス）」の検索式がおすすめです
            </span>
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-200 text-sm font-bold text-amber-800">
            4
          </span>
          <span>
            検索結果画面で「CSV出力」ボタンを押してダウンロードします
            <br />
            <span className="text-sm font-medium text-red-700">
              ※ CSV 出力には J-PlatPat へのログインが必要です
            </span>
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-200 text-sm font-bold text-amber-800">
            5
          </span>
          <span>
            ダウンロードした CSV ファイルを、次の
            <strong>「ステップ 4: 検索結果の取り込み」</strong>
            でアップロードしてください
          </span>
        </li>
      </ol>
    </div>
  );
}
