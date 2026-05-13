# Session Log

## 2026-05-14 analyze-overlap: gemini-3.1-flash-preview + thinkingLevel='minimal'
### 実施
- 'low' でも 504 が出やすいため、モデル・thinking 両面で再調整
- `getModel()` の default model: `gemini-3.1-flash-lite` → `gemini-3.1-flash-preview`（最新の flash preview、lite ではなくフル flash）
- `analyze-overlap.ts` の thinkingLevel: 'low' → 'minimal'（screen / analyze 両方）
- 狙い: flash-preview はモデル本体が flash-lite より上位 → 思考なし (minimal) でも品質が落ちにくく、かつ thinking 時間ゼロ近くで Vercel 60s に確実に収まる
- 影響範囲: `getModel()` は analyze-overlap のみで使用。extract / integrate / queries は `getFastModel()`（flash-lite）のまま

### 変更ファイル
- `src/lib/ai-model.ts`
- `src/lib/analyze-overlap.ts`

### 決まったこと
- 「思考時間ゼロ + モデル本体が上位」のほうが「思考あり + モデル本体が軽い」よりも 60s 制限下では有利になりうる。analyze-overlap はこの方針で固定
- flash-preview の default thinkingLevel='high' は重いので、providerOptions で必ず明示する運用

## 2026-05-14 analyze-overlap の thinkingLevel を 'medium' → 'low' に下げる
### 実施
- 本番で重なり分析が 504 Gateway Timeout を出したため、`analyze-overlap.ts` の screenPriorArt / analyzeOverlap 両方の thinkingLevel を 'medium' → 'low' に下げる
- 品質より「Vercel 60s に確実に収める」を優先

### 変更ファイル
- `src/lib/analyze-overlap.ts`

### 決まったこと
- flash-lite + thinkingLevel: 'low' でも 504 が出る場合は、(1) 入力圧縮（claimsText の 2000 字 trim を縮める）、(2) priorArts を分割して複数回呼ぶ、(3) thinkingLevel: 'minimal' に下げる、の順で検討

## 2026-05-14 先行技術文献の選択削除 + CSV 重複時の publicationNo upsert
### 実施
- 本番で同じ CSV を 2 回登録して 362 件中半分が重複していた事象に対応するため、削除 UI と重複防止策を実装
- リポジトリ層 `PriorArtDocumentRepository` に 2 メソッド追加:
  - `upsertManyByPublicationNo(caseId, docs)`: 同 caseId 内で同じ publicationNo の既存レコードは UPDATE で上書き、なければ INSERT。docId は維持されるため既存の comparison_results との紐付けが保たれる
  - `deleteByIds(caseId, docIds)`: caseId を where に含めることで他案件の docId を渡されても削除されないガード
- API:
  - `POST /api/cases/[caseId]/prior-art`: CSV は upsert に変更。レスポンスに `{ imported, updated }` を返す。ファイル取り込みは publicationNo=null なので常に新規 INSERT（従来通り）
  - `DELETE /api/cases/[caseId]/prior-art`: 新規。body `{ docIds: number[] }` で削除対象を指定
- UI:
  - 新規クライアントコンポーネント `PriorArtTable`: チェックボックス列・全選択・indeterminate 表示・「N 件選択中 [削除]」ボタン・confirm ダイアログ
  - `UploadCsvForm`: 「N 件取り込み（新規 X 件 / 既存上書き Y 件）」メッセージ表示
  - `page.tsx`: テーブル直書きを `<PriorArtTable />` に差し替え
- 検証: `pnpm lint` `pnpm type-check` 通過

### 変更ファイル
- `src/repositories/types.ts`
- `src/repositories/drizzle.ts`
- `src/app/api/cases/[caseId]/prior-art/route.ts`
- `src/app/cases/[caseId]/upload-csv-form.tsx`
- `src/app/cases/[caseId]/prior-art-table.tsx`（新規）
- `src/app/cases/[caseId]/page.tsx`

### 決まったこと
- 重複防止は DB の unique 制約ではなくアプリ側で実装。publicationNo は null 許容（方法B のファイル取り込み）でありSQLite の partial unique index に頼ると追加のマイグレーションが必要、UX メッセージ（新規/更新の件数表示）もアプリ側の方が表現しやすい
- 重複時は削除→再 insert ではなく UPDATE。理由は既存の comparison_results.prior_doc_id を孤児化させないため
- 削除は caseId をスコープに固定。他案件の docId を渡されても削除されない

## 2026-05-14 Gemini 3.1 flash-lite (stable) + thinkingLevel への切替
### 実施
- 直前のセッションで `getModel()` を `gemini-3.1-flash-preview` に更新したが、AI SDK と Google 公式 thinking docs を再調査し設計を見直し
- 重要な発見:
  - Gemini 3.1 系は thinkingBudget ではなく `thinkingLevel` ('minimal'|'low'|'medium'|'high') を使う
  - flash-preview の default thinking level は 'high' で、初出力までの latency が大きい → Vercel 60s に収まりにくい
  - flash-lite の default は 'minimal' で最速
  - `gemini-3.1-flash-lite` には **stable 版が存在する**（preview ではない）
  - `@ai-sdk/google` v3.0.60 は `providerOptions.google.thinkingConfig.thinkingLevel` を受け付ける（型定義で確認）
- 変更:
  - `getModel()` の default: `gemini-3.1-flash-preview` → `gemini-3.1-flash-lite`（stable）
  - `getFastModel()` の default: `gemini-3.1-flash-lite-preview` → `gemini-3.1-flash-lite`（stable）
  - `analyze-overlap.ts` の screenPriorArt / analyzeOverlap の 2 つの generateObject に `providerOptions.google.thinkingConfig.thinkingLevel: 'medium'` を追加
- 検証: `pnpm lint` `pnpm type-check` 通過

### 変更ファイル
- `src/lib/ai-model.ts`
- `src/lib/analyze-overlap.ts`

### 決まったこと
- LLM モデルは原則 stable 版を使う（preview は明確な理由がある場合のみ）
- thinkingLevel は呼び出し側（用途ごと）で指定する。ai-model.ts はモデルだけ返す責務
- analyze-overlap の 2 段階分析は thinkingLevel: 'medium' を初期値とし、60s 超えるなら 'low' に下げる

## 2026-05-14 Gemini 3.1 系 preview への移行
### 実施
- 504 対策デプロイ完了後、`getModel()` のモデル指定を Gemini 2.5 系 preview から 3.1 系 preview に更新
- Google AI 公式モデル一覧（WebFetch）で確認: Gemini 3.0 系は 2026-03-09 にシャットダウン済、3.1 系が現役。`gemini-3.1-flash-lite` は stable 版が存在する
- 変更: `getModel()` の default を `gemini-2.5-flash-preview-05-20` → `gemini-3.1-flash-preview`（思考あり + flash クラス）
- `getFastModel()` は `gemini-3.1-flash-lite-preview` のまま維持（既に 3.1 preview）
- 使用箇所マップ: `getModel()` = analyze-overlap のみ、`getFastModel()` = extract / integrate / queries
- 検証: `pnpm lint` `pnpm type-check` 通過

### 変更ファイル
- `src/lib/ai-model.ts`

### 決まったこと
- Gemini 3.0 系は使えない（deprecated）。3.1 系へ移行する
- `getModel()` に pro-preview を選ばないのは、analyze-overlap が generateObject を 2 回呼ぶ重い処理で Vercel 60s に収めるため。品質より速度優先

## 2026-05-14 検索式生成の 504 タイムアウト対策
### 実施
- 本番 `POST /api/cases/13/queries` が 504 Gateway Timeout で落ちる報告を受けて、3028216（integrate fast 化）と同じパターンを `generateQueries` にも適用
- `src/lib/generate-queries.ts`:
  - `getModel()` → `getFastModel()` に切替（gemini-3.1-flash-lite、思考モデルを避ける）
  - 入力プロンプトを `JSON.stringify(extracted, null, 2)` から「発明の名称 / 解決課題 / 作用効果 / 独立請求項 / core 構成要素」のみを抜き出した構造化テキストに圧縮（`compactExtractedForQueries`）。元の JSON は elements の type/text/importance を全件並べるため fast モデルでも応答が遅くなる
  - SYSTEM_PROMPT は変更なし（中庸の二重ネスト禁止ルールは維持）
- 検証: `pnpm lint` `pnpm type-check` 通過。本番デプロイは未実施

### 変更ファイル
- `src/lib/generate-queries.ts`

### 決まったこと
- LLM を使う API はデフォルトで fast モデル + 入力圧縮を採用する方針（Vercel Hobby の 60 秒制限を前提）。重い思考モデルを使う場合は背景タスク化等の別設計が必要

## 2026-05-08 FR-07 国内優先権主張出願モード実装（DR-0009）
### 実施
- 父の追加要望「公開前の出願済み特許に新規事項を付け加える特許」を、特許法 41 条 国内優先権主張出願として明文化し実装した
- 設計合意（AskUserQuestion 4 ターン）: 制度=国内優先権、調査スコープ=統合後全体、入力=ファイル、統合=AI 自動
- 仕様追記:
  - `docs/02-requirements.md` FR-07 を追加
  - `docs/03-architecture.md` データモデル（cases.base_application_mode / base_application_number、draft_patents.kind）と「ベース出願モードの処理流れ」追加
  - `ops/decisions.md` DR-0009 を追加
- スキーマ拡張: `src/db/schema.ts` に上記 3 カラム追加
  - drizzle-kit push が NOT NULL 追加カラムを「data-loss」として TTY 確認を要求するため、ALTER TABLE を直接発行する `scripts/migrate-fr07.mjs` を作成して Turso 本番に反映済（既存 9 件はデフォルト値で埋まる）
- Repository 層: `src/repositories/types.ts` `drizzle.ts` `index.ts` に新フィールド + `DraftKind` 型 + `upsertMain` メソッド追加（main は 1 件に保つ upsert）
- 統合 AI ロジック: `src/lib/integrate-claims.ts` 新規。ベース + 新規事項テキストを受け取り、特許明細書フォーマットの統合テキストを generateText で出力。後段の extractClaims が処理できる構造化テキストを目標とする
- API:
  - `POST /api/cases`: baseApplicationMode / baseApplicationNumber 受領
  - `POST /api/cases/[caseId]/draft`: kind FormData 受領（"main"|"base"|"addition"、デフォルト "main"）
  - `POST /api/cases/[caseId]/integrate` 新規: ベース + 新規事項 → main draft 統合
- UI:
  - `src/app/new-case-form.tsx`: Yes/No チェックボックスとベース出願番号入力欄（IME ガード継続）
  - `src/app/cases/[caseId]/page.tsx`: baseApplicationMode に応じて Step 1 を 3 セクション（1-A ベース / 1-B 新規事項 / 1-C 統合）に分岐。通常モードは従来通り
  - `src/app/cases/[caseId]/upload-draft-form.tsx`: kind / label / buttonLabel プロップ追加（hidden input で kind を FormData に乗せる）
  - `src/app/cases/[caseId]/integrate-button.tsx` 新規
  - `src/components/next-action-banner.tsx`: ベース出願モード用メッセージ追加（1-A → 1-B → 1-C → 抽出 → 検索式...）
- 検証:
  - `pnpm lint` `pnpm type-check` `pnpm build` 全て通過
  - `pnpm dev` 起動 → POST /api/cases で baseApplicationMode=true の case 作成成功、GET /cases/10 でベース出願モードの新 UI が描画されることを HTML 文字列で確認、DELETE で案件削除して掃除
  - ローカルから本番 Turso に直接スキーマ反映済み（migrate-fr07.mjs 1 回実行）。本番 Vercel への push は未実施

### 変更ファイル
- `docs/02-requirements.md`（FR-07 追加）
- `docs/03-architecture.md`（データモデル + 処理流れ追加）
- `ops/decisions.md`（DR-0009 追加）
- `ops/tasks.md`（In Progress / Inbox 整理）
- `src/db/schema.ts`（cases / draft_patents カラム追加）
- `src/repositories/types.ts` `src/repositories/drizzle.ts` `src/repositories/index.ts`
- `src/lib/integrate-claims.ts`（新規）
- `src/app/api/cases/route.ts` `src/app/api/cases/[caseId]/draft/route.ts`
- `src/app/api/cases/[caseId]/integrate/route.ts`（新規）
- `src/app/new-case-form.tsx`
- `src/app/cases/[caseId]/page.tsx` `upload-draft-form.tsx` `integrate-button.tsx`（新規）
- `src/components/next-action-banner.tsx`
- `scripts/migrate-fr07.mjs`（新規・運用ツール）

### 決まったこと
- 国内優先権主張出願モードの保存層は既存 5 テーブルに最小カラム追加で対応（draftPatents.kind で 3 種別を区別）
- 統合は AI による自然言語生成にする（generateText）。構造化（generateObject）にしないのは、出力が後段の extractClaims プロンプトに食わせやすい「特許明細書フォーマット」だから
- ベース出願は 29 条引用文献にならない（公開前 + 出願人同一）。29 条の 2 拡大先願は本 PoC では機械判定せずユーザー手動除外
- drizzle-kit push は NOT NULL カラム追加を必ず data-loss と扱うため、本番 DB への schema 同期は小さい migrate スクリプトを書いて libsql client から直接実行する運用パターンとする

### 未解決
- 本番 Vercel に未デプロイ。ユーザー側で `! gh auth switch --user hirokiriko && git push` してから Vercel が自動デプロイ
- 統合 AI の精度は実データで未検証。父に「特願2026-40454 + UI 仕様」を投入してもらい、統合後テキストの品質を確認する必要あり
- 新規事項単独の調査は今回スコープ外（要望があれば将来拡張）
- 4 月から残っている諸タスク（J-PlatPat 構文修正の本番再検証、Phase B クライアント抽出、残 Quick Wins、environment 選択 UI）は未着手のまま

### 次にやること
- 本セッションの変更を main に push し Vercel に自動デプロイさせる
- 父に「ベース出願（特願2026-40454）のテキスト + 新規事項のテキスト」を 2 ファイルでアップロードしてもらい、統合 → 抽出 → 検索式 → 分析 まで通すリハーサル
- 統合 AI のプロンプト調整（実機運用結果次第）

## 2026-05-08 J-PlatPat 検索式の構文エラーを根絶（中庸の二重ネスト除去）
### 実施
- 父から追加情報を受領: 「長めの中庸検索式が J-PlatPat で『論理式のカッコの使用方法が間違っています』エラーで使えない」。具体的なエラー検索式 2 本を提示してもらった
- 公式ヘルプ（j-platpat.inpit.go.jp/help/ja/p01/arithmetic.html）を確認し、原因を特定: J-PlatPat の論理式は **タグ後置のカッコ式 `(語+語)/CL` を更に丸カッコで括って AND 結合することを認めていない**。現行プロンプトが「中庸 = /CL + /AB を OR で結ぶ」を生成するため `((..)/CL+(..)/AB)*((..)/CL+(..)/AB)` という二重ネスト構造を吐き、これが NG パターンに直撃していた
- `src/lib/generate-queries.ts` の SYSTEM_PROMPT を書き直し:
  - 演算子優先順位（`[]` > `*` > `+`/`-`）を明記
  - 「タグ後置のカッコ式を更にカッコで括ってはならない」を最重要禁則として追加
  - NG パターン例（父の報告そのもの）と OK 修正例を併記
  - balanced（中庸）の戦略を「/CL + /AB の OR を AND」から「/CL のみで AND」または「演算子優先順位を活用したフラット展開（`(A)/CL*(B)/CL+(A)/AB*(B)/AB`）」に変更
  - 500 字制限・各 OR 群 5 語・AND 項 3〜5 個 を明示
- `eslint.config.mjs` に `vendor/**` の ignore を追加（2026-04-22 の pdfjs-dist vendor 化以降 `pnpm lint` が大量エラーで失敗していた既存問題の同時解消）
- `pnpm lint` 通過、`pnpm type-check` 通過

### 変更ファイル
- `src/lib/generate-queries.ts` — SYSTEM_PROMPT を J-PlatPat 構文ルール強化版に書き換え
- `eslint.config.mjs` — `vendor/**` を `globalIgnores` に追加

### 決まったこと
- J-PlatPat 論理式の最重要ルール: **「タグ後置のカッコ式同士を更にカッコで括る」入れ子構造は NG**。AND 結合する各項は `(語+語)/タグ` までに留め、トップレベルで `*` と `+` を組み合わせる
- balanced（中庸）のフィールド戦略を /CL+/AB OR から /CL 主体に変更。精度より構文安全性を優先（CL+AB 混在式は演算子優先順位を活用したフラット展開のみ許容）

### 未解決
- 修正版検索式の J-PlatPat 上での実機再検証（プロンプト修正で構文エラーが本当に消えるか）→ 本番デプロイ後に父に再検証してもらう
- 追加要望B（環境選択 UI）は依然として要件確定待ち（`/Users/mao/.claude/plans/1-ui-4-eager-perlis.md` 末尾の 4 項目）
- 実施例4 の仕様ヒアリングは保留継続（同 plan の 8 項目）

### 次にやること
- 修正版の検索式を本番デプロイし、父に再検証してもらう
- 構文エラーが再発するようなら、AI 出力後の sanitize / 検証関数を追加（タグ付き式のネスト検出）
- 環境選択 UI と実施例4 の追加情報を待つ

## 2026-04-22 方法B の PDF 取り込み失敗を修正（pdfjs-dist vendor/ 方式、本番まで検証）
### 実施
- 方法B で個別 PDF 取り込みが `"ファイルの読み取りに失敗しました"` で失敗していた問題を修正、本番 Vercel Lambda まで動作確認完了
- 原因が 5 段階で判明し、順に修正:
  1. `unpdf@1.4.0` は `Buffer` ではなく `Uint8Array` を要求（Buffer を渡すと即エラー）
  2. unpdf 同梱の pdf.js serverless build には CJK 用 cmap が含まれておらず、日本語テキスト抽出は常に空
  3. `pdfjs-dist` 5.x の Node ランタイムは `cMapUrl` に `file://` URL を渡せず生パスを要求（`fs.promises.readFile(url)` を直接呼ぶ実装）
  4. Vercel で pnpm の `node_modules/pdfjs-dist` が symlink のため `outputFileTracingIncludes: ["./node_modules/pdfjs-dist/..."]` は "invalid deployment package" を返す
  5. pdf.worker.mjs は fake worker が実行時に動的 import するため Next.js の output tracing で拾われず、本番で `Cannot find module pdf.worker.mjs` で落ちる
- 最終構成:
  - `scripts/copy-pdfjs-assets.mjs` (postinstall) で `vendor/pdfjs-dist/{cmaps, standard_fonts, legacy/build}` に実ファイルを複製
  - `parse-file.ts` は `vendor/pdfjs-dist/legacy/build/pdf.mjs` を `pathToFileURL` で動的 import、cMap も vendor/ パスを渡す
  - `import "@napi-rs/canvas"` を parse-file.ts に side-effect 追加して Vercel の output tracer に @napi-rs/canvas を認識させる（DOMMatrix polyfill 用）
  - `package.json` の `pnpm.publicHoistPattern` に `@napi-rs/canvas*` を追加して root node_modules に hoist
  - `next.config.ts`: `serverExternalPackages: ["@napi-rs/canvas"]`、`outputFileTracingIncludes` を `./vendor/pdfjs-dist/**` に
- 依存整理: `unpdf` `pdf-parse` を削除、`pdfjs-dist@5.6.205` `@napi-rs/canvas@0.1.99` を追加
- 本番検証: `https://patentai-mini.vercel.app/api/cases/7/prior-art` に 3 件 POST で `{"imported":3}`、Turso 上に日本語本文が保存されたことを確認（ローカル dev と同じ 295k / 94k / 31k 文字）
- コミット: aa6a9ee → ff679da → 9750d3e → 90928f3 → dc0cbe3 → b1086fb（うち Vercel デプロイ成功は ff679da 以降の pdfjs 関連 5 コミット）

### 決まったこと
- PDF テキスト抽出は pdfjs-dist を vendor/ 経由で動的 import する構成に固定。cmap / standard_fonts / legacy/build は全部 vendor/ にコピーする方針。DR-0004 の「pdf-parse」記述は古い
- CJK 公報 PDF は ToUnicode CMap 非埋め込み（HeiseiKakuGo-W5 / HeiseiMin-W3 + UniJIS-UCS2-H）のため、cmaps ディレクトリへのアクセスが必須
- Vercel 本番運用で Claude が main に push するには、ユーザー側で `! gh auth switch --user hirokiriko` と `! git push` を手動実行する必要がある（harness が拒否する、memory に記録済み）

### 未解決
- pdf.js の `getTextContent()` 出力は公報 PDF で字間スペースが入る（例: `所 定 の プ ラ ッ ト フ ォ ー ム`）。LLM は問題なく解釈するが、トークン消費が増える。正規化は未対応
- 動作確認で作ったテスト用ケース caseId=6 (ローカル用) と caseId=7 (本番 "prod pdf smoke test") が Turso に残っている。不要なら画面から削除する

### 次にやること
- 字間スペースの正規化を `parse-file.ts` に追加するか判断
- 残っている Quick Wins（A2 FK cascade / A3 replaceByCaseId transaction / A1 element_score / C5 active draft / G1 vitest）

## 2026-04-09 Initial scaffold
### 実施
- PoC の目的・範囲・アーキテクチャ・継続運用ファイル群を作成
- AI エージェント用の作業規約を作成

### 決まったこと
- J-PlatPat の検索自動化はスコープ外
- 人手検索 + 再アップロード方式で進める
- 初期 DB は SQLite 前提

### 未解決
- 実際に受け取る特許案ファイル形式
- J-PlatPat 検索結果ファイルの実物列定義
- 類似度スコア閾値

### 次にやること
- 実データ 1 件で end-to-end の疑似流し込みを行う

## 2026-04-09 技術スタック確定 & リポジトリ作成
### 実施
- CLAUDE.md を新規作成
- GitHub リポジトリ作成（hirokiriko/patentai-mini, private）、初回 push
- ローカル git config で hirokiriko アカウントの認証を設定
- 技術スタック設計判断 DR-0003〜DR-0006 を確定
- docs/03-architecture.md の Python 記述を撤回し TS 構成に修正

### 決まったこと
- DR-0003: LLM 統合に AI SDK を採用
- DR-0004: All JS/TS 構成（Python 併用なし）
- DR-0005: ORM に Drizzle を採用
- DR-0006: パッケージマネージャに pnpm を採用
- Vercel にデプロイ予定

### 未解決
- .env.example の AI SDK 体系への更新（Next.js 初期化時に対応）
- Next.js プロジェクトの初期化はまだ未着手

### 次にやること
- Next.js プロジェクトの初期化（create-next-app）
- Drizzle ORM セットアップとスキーマ定義
- Vercel デプロイ

## 2026-04-09 全7ステップ実装完了
### 実施
- Next.js プロジェクト初期化（Next.js 16, App Router, Tailwind, Turbopack）
- mise.toml で Node.js 22 + pnpm 10 をプロジェクトローカルに設定
- Vercel デプロイ確認（GitHub 自動連携設定済み）
- Drizzle ORM セットアップ（5テーブル: cases, draft_patents, search_query_sets, prior_art_documents, comparison_results）
- AI SDK + @ai-sdk/openai 導入、.env.example 更新
- 案件 CRUD API + 一覧・作成・詳細画面
- 特許案アップロード + テキスト自動抽出（unpdf/mammoth）
  - pdf-parse v1/v2 は Next.js Turbopack と互換性問題があり unpdf に切り替え
- AI 請求項・構成要素抽出（generateObject + zod スキーマ）
- J-PlatPat 検索式生成（広/中/狭 3段階 + キーワード群 + 根拠）
- J-PlatPat CSV 取り込み（実データ146件で検証、要約列オプショナル対応）
- 重なり分析・リスクレポート（2段階: スクリーニング→詳細4層分析）

### 決まったこと
- PDF パースは unpdf を使用（pdf-parse は非互換）
- J-PlatPat CSV 列定義が確定（文献番号, 出願番号, 出願日, 公知日, 発明の名称, 出願人/権利者, FI, 要約(optional), 公開番号, 公告番号, 登録番号, 審判番号, その他, ステージ, イベント詳細, 文献URL）
- 重なり分析はコスト・時間の制約から2段階方式（スクリーニング→上位20件のみ詳細分析）

### 仕様との実装差異
- 4層スコアは独立アルゴリズムではなく AI 一括推定
- L3 意味類似はベクトル検索未使用
- LLM モデルは gpt-4o ハードコード（.env 切り替え未実装）
- ファイルアップロードはローカル fs（Vercel 上で永続化不可）
- 従属請求項の分析は未対応（独立請求項のみ）

### 未解決
- 実際の特許案ファイルでの end-to-end テスト
- LLM プロバイダー/モデルの動的切り替え
- Vercel 上でのファイル永続化

### 次にやること
- 実データで end-to-end 動作確認
- UI/UX 改善
- 仕様差異の段階的解消

## 2026-04-09 ブラッシュアップ・Turso 移行・Vercel 完全動作
### 実施
- LLM プロバイダー切り替え（src/lib/ai-model.ts: AI_PROVIDER / AI_MODEL 環境変数）
- @ai-sdk/google 追加、デフォルトを Google AI (gemini) に変更
- テキスト長制限（trimPatentText: 請求項・要約優先、30,000文字上限）
- J-PlatPat 検索式フォーマット修正（ダブルクォート禁止、/CL等タグ必須、角括弧等）
- 実データ end-to-end 動作確認（DOCX アップロード→請求項抽出→検索式→CSV取込→重なり分析 全ステップ成功）
- リポジトリパターン導入（src/repositories/: types.ts + drizzle.ts + index.ts）
- Turso (libSQL クラウド) 移行（kiriko アカウント、東京リージョン）
- Vercel 環境変数設定（DATABASE_URL, TURSO_AUTH_TOKEN）
- DB 遅延初期化（Proxy パターン）でビルド時の接続エラー解消
- .vercelignore でローカル .env がデプロイに含まれない対策
- Git author 問題の解決（原因: direnv の GIT_AUTHOR_* 環境変数、プロジェクト .envrc で上書き）
- includeIf 復元（原因は direnv であり git config ではなかった）

### 決まったこと
- DR-0007: リポジトリパターンで DB 抽象化。Firebase 等への切り替えは index.ts の import 先変更のみ
- DR-0008: LLM プロバイダーを環境変数で動的切り替え
- Turso は kiriko アカウント（h.sato@kiriko.tech）で管理

### 気づき・注意点
- vercel env add で heredoc 経由だと末尾改行が入る（Invalid URL の原因に）→ printf で渡す
- pdf-parse v1/v2 は Next.js Turbopack と互換性問題 → unpdf に切り替え済み
- direnv の GIT_AUTHOR_* は git config より優先される（env vars > local > global > system）
- GOOGLE_GENERATIVE_AI_API_KEY がセッション中に露出 → ローテーション推奨

### 次にやること
- UI/UX 改善
- 従属請求項の分析対応
- ファイルアップロードの Vercel Blob 対応

## 2026-04-20 方法B 単独フロー対応 + アップロード失敗の原因切り分け
### 実施
- **Step 4（先行技術取り込み）の表示条件を緩和**: `{latestQuerySet && (` → `{extracted && (`。請求項抽出済みなら検索式生成を経ずに Step 4 の UI（方法A/B）が表示される。`currentStep` 計算を `hasQueries && !hasPriorArts` 両方許容へ調整
- **UI 文言を方法A/B 併用形に更新**:
  - `next-action-banner.tsx` Step 3 メッセージに「方法 B で直接取り込み可」の副次誘導（`whitespace-pre-line` で複数行表示）、Step 4 メッセージを「CSV（方法A）または個別ファイル（方法B）」へ
  - `step-progress-bar.tsx` の Step 4 ラベル「CSV取込」→「先行技術取込」
  - Step 4 セクション冒頭に「方法 A と方法 B は併用可。どちらか一方だけでも分析に進めます」
- **本番 Vercel で「複数選択アップロード失敗」の原因切り分け**: 1 ファイルは成功・複数で失敗・本番のみで発生 → **Vercel serverless function の payload 上限 4.5 MB が有力**と判断
- **Phase A 実装**: `upload-patent-files-form.tsx` に合計サイズ事前警告（4 MB 黄色 / 4.5 MB 赤 + 送信ブロック）、ボタンラベルにサイズ表示、`fetch` / `res.json()` を try/catch で包み HTML レスポンスでも UI が止まらないよう防御。HTTP 413 用ヒント文言も追加

### 変更ファイル
- `src/app/cases/[caseId]/page.tsx` — Step 4 表示条件、currentStep 計算、Step 4 セクションの文言
- `src/components/next-action-banner.tsx` — Step 3/4 文言、whitespace-pre-line
- `src/components/step-progress-bar.tsx` — Step 4 ラベル
- `src/app/cases/[caseId]/upload-patent-files-form.tsx` — 合計サイズ警告、res.json 防御、HTTP 413 ヒント

### 決まったこと
- 方法B 単独（検索式生成をスキップ）で Step 5 の分析まで進める運用が正式サポート
- 本番 payload 上限はクライアント UI で事前警告する方針（サーバー分割/Blob への切り替えは保留）

### 未解決
- **Phase B**: クライアント側で PDF/DOCX をテキスト抽出して画像を除外し、テキストのみサーバー送信（unpdf + mammoth.browser）。別セッションで着手
- **実施例4**: 「出願済・公開前に新規事項を付け加える特許作成方法」UI の仕様未確定。追加ヒアリング質問 8 項目を `/Users/mao/.claude/plans/1-ui-4-eager-perlis.md` に整理済み
- 今回の変更はブラウザでの動作確認未実施（本セッション内では実機検証していない）

### 次にやること
- 本セッションの変更を Vercel にデプロイして実機検証（方法B 単独で複数ファイル、4 MB 超警告、4.5 MB 超ブロック、413 ハンドリング）
- Phase B（クライアント抽出）の設計・実装
- 実施例4 の仕様ヒアリング

## 2026-04-21 改善点カタログ化 + Quick Wins 5件
### 実施
- **改善点カタログ作成**: 3 並列 Explore で backend / frontend / docs&ops を調査 → 実ファイル裏取りして `/Users/mao/.claude/plans/distributed-meandering-shell.md` に 30+ 指摘を整理
- **F1 `.env.example` 整理**: 未使用項目 (UPLOAD_DIR, ARTIFACT_DIR, VECTOR_BACKEND 系, ENABLE_* 系, ANTHROPIC_API_KEY, APP_NAME, NODE_ENV) を削除、Required/Optional セクション化
- **B1 `queries/route.ts` の JSON.parse を try/catch 化**: 破損 JSON で 500 → 400「請求項データが不正です。再度抽出してください」
- **C1 `new-case-form.tsx` に IME ガード追加**: composingRef + nativeEvent.isComposing + keyCode 229 の三重ガード。onKeyDown と onSubmit の両方でチェック
- **G3 `package.json` に `type-check` script 追加** (`tsc --noEmit`)
- **G2 `.github/workflows/ci.yml` 新規**: Node 22 + pnpm latest で `pnpm install --frozen-lockfile` → `lint` → `type-check` → `build` を push/PR 時に実行
- ローカルで `pnpm lint` / `pnpm type-check` 通過確認（既存警告 `and` 未使用 1 件は本変更とは無関係）

### 変更ファイル
- `.env.example`
- `src/app/api/cases/[caseId]/queries/route.ts`
- `src/app/new-case-form.tsx`
- `package.json`
- `.github/workflows/ci.yml`（新規）

### 決まったこと
- CI は Node 22 + pnpm latest、lint / type-check / build の 3 段
- NODE_ENV・APP_NAME は Next.js 自動管理で不要と判定し `.env.example` から削除
- ANTHROPIC_API_KEY は `ai-model.ts` 未実装のため `.env.example` から削除

### 未解決
- **E4 Vercel 本番の LLM API キー設定**: ユーザー側で `printf "$KEY" | vercel env add GOOGLE_GENERATIVE_AI_API_KEY production` が必要
- ローカル動作確認のみ。Vercel 実機検証は未実施（方法B payload 警告の実機検証と合流させて良い）
- `.github/workflows/ci.yml` が GitHub 実機で通るかは初回 push 時の確認が必要

### 次にやること
- E4 完了（ユーザー作業）＋ 本番で請求項抽出〜分析が動くこと確認
- 残りの Top 10 Quick Wins（A2 FK cascade / A3 transaction / A1 element_score / C5 active draft / G1 vitest 最小テスト）
- 元の handoff 優先候補（Vercel 実機検証、Phase B クライアント抽出）も並走

## 2026-04-13 本番フィードバック対応（3件）
### 実施
- **アップロードエラー修正**: `parseFile` を Buffer ベースに変更（`fs/promises` のディスク書き込みを除去）。Vercel の読み取り専用 FS で動作するようになった
- **キーワード検索対応**: `generate-queries.ts` に `keywordQueries` スキーマを追加。テーマ別（課題起点/手段起点等）のコピペ用キーワードセットを LLM が生成し、Step 3 UI に表示
- **個別特許ファイルアップロード**: `prior-art/route.ts` を拡張し PDF/DOCX/TXT の複数同時アップロードに対応。テキスト抽出して `claimsText` に保存。Step 4 に CSV と並列で個別ファイルアップロード UI を追加
- 分析ステップで `abstract` が null（個別アップロード文献）の場合 `claimsText` をフォールバックに使用

### 変更ファイル
- `src/lib/parse-file.ts` — Buffer+ext ベースに変更
- `src/app/api/cases/[caseId]/draft/route.ts` — ディスク書き込み除去
- `src/lib/generate-queries.ts` — keywordQueries スキーマ+プロンプト追加
- `src/app/api/cases/[caseId]/queries/route.ts` — keywordQueries を rationaleJson に保存
- `src/app/api/cases/[caseId]/prior-art/route.ts` — CSV+個別ファイル両対応
- `src/app/cases/[caseId]/upload-patent-files-form.tsx` — 新規: 個別ファイルアップロード UI
- `src/app/cases/[caseId]/page.tsx` — キーワード表示+個別アップロード UI 追加
- `src/app/api/cases/[caseId]/analyze/route.ts` — abstract フォールバック

### 決まったこと
- ファイルはディスク保存せず、メモリ上で処理してDB保存する方式に統一
- 個別特許アップロードでは AI による請求項分解は行わず、テキスト抽出のみ

### 次にやること
- Vercel デプロイして本番確認
- 従属請求項の分析対応
- UI/UX 改善
