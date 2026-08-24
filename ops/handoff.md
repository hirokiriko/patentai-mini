# Handoff

> [!NOTE]
> このファイルはIssue Driven移行前の履歴資料です。新規タスク、進捗、引継ぎの正本として更新しません。
> 現行状態はGitHub Issue／PR、default branch、CI、および必要な実環境で確認してください。
> 本文を新しいIssue／PRへ無差別に転記しないでください。


## 現在地
2026-05-14（本セッション・8 件目）本番で「Thinking level MINIMAL is not supported for this model」エラー。flash-preview が minimal 非サポートと判明。ユーザー選択で flash-lite + minimal の構成（スピード最優先、品質許容）に戻す。`pnpm lint` / `pnpm type-check` 通過、未コミット。

過去の実環境検証で先行技術文献削除時のFK制約違反を確認し、関連する比較結果を先に削除する形へ修正した。実データ識別子は削除済み。

2026-05-14 'low' でも 504 が出やすいため、analyze-overlap の構成を再調整。`getModel()` の model を `gemini-3.1-flash-preview` に切替、thinkingLevel を 'minimal' に下げる（screen / analyze 両方）。コミット `0401280` デプロイ済。

2026-05-14 本番で重なり分析が 504 を返したため、`analyze-overlap.ts` の thinkingLevel を 'medium' → 'low' に下げる（コミット `adffa36` デプロイ済）。ただし 'low' でもまだ 504 出やすいことが判明、追加調整中。

過去の実環境でCSV重複登録に対応するため、選択削除UIとpublicationNo upsertを実装した。実データの件数と識別子は削除済み。

2026-05-14 AI SDK と Google 公式 thinking docs を再調査し設計見直し。`getModel()` / `getFastModel()` の default を `gemini-3.1-flash-lite`（stable、preview 未使用）に統一。analyze-overlap の 2 つの generateObject に `providerOptions.google.thinkingConfig.thinkingLevel: 'medium'` を追加。コミット `b2627b0` で本番デプロイ完了。analyze-overlap の 60s 収まり実機検証は未実施。

2026-05-14 `getModel()` のモデル指定を Gemini 2.5 系 preview から 3.1 系 preview (`gemini-3.1-flash-preview`) に更新（コミット `a4877b8`、未 push）。直後にユーザー指示で `gemini-3.1-flash-lite`(stable) に再変更したため、このコミットは flash-preview を一度経由する形になっている。

検索式生成のtimeout対策としてfastモデルと入力圧縮を適用し、deploy先で動作確認した。実データ識別子は削除済み。

国内優先権主張出願モード（DR-0009）を実装した。非公開要件、関係者情報、実データ識別子、旧DB操作の詳細は公開履歴から削除した。

J-PlatPat検索式の構文エラー対策として、タグ付き式の二重ネストを避けるプロンプトへ更新し、lintとtype-checkを確認した。関係者情報と非公開入力は削除済み。

PDF取り込みのvendor方式をローカルとdeploy先で確認した。環境固有URL、実データ識別子、Production DB内容、個人パスは削除済み。

改善点カタログとQuick Winsを実施した。ローカル個人パスは削除し、非機密の技術履歴だけを保持する。

## 次セッションの優先候補
1. **FR-07のend-to-end確認** — deploy後は、承認された非機密fixtureで統合、請求項抽出、検索式生成、分析を確認する。未公開資料や実案件データを公開ワークフローへ持ち込まない
2. **J-PlatPat構文再検証** — 修正版の広／中／狭検索式について、指定レビュアーが構文エラー解消を確認する
2. **構文エラーが再発した場合**: `src/lib/generate-queries.ts` に出力後の sanitize / 検証関数を追加（タグ後置の式が更にカッコで括られているケースを検出して再生成またはフラット展開に変換）
3. **残り Quick Wins** — A2 FK cascade / A3 `replaceByCaseId` トランザクション / A1 `element_score` カラム追加 / C5 複数ドラフト active 明示 / G1 主要 4 モジュール vitest テスト
4. **Phase B 実装** — クライアントで PDF/DOCX をテキスト抽出し画像を除外（pdfjs-dist + mammoth.browser）、サーバーに JSON 経路追加して payload を数百 KB 以下へ
5. **環境選択UI** — 要件を自己完結Issueへ公開可能な表現で記録してから着手する
6. **非公開要件の確認** — 詳細は公開履歴へ記載せず、必要な判断だけを安全なIssueへ一般化する
7. 従属請求項の分析対応
8. LLM プロバイダー追加（anthropic 等）

## 旧環境情報（識別情報削除済み）
- **旧hosting**: 環境固有URLと個別アカウントを削除。現行deploy経路はdefault branchとworkflowを確認する
- **旧DB**: 個別アカウント、メール、接続先、Production内容を削除。現行DBはPostgres
- **旧AI設定**: provider名以外の値と登録状態は記録しない。現行providerはGoogle／OpenAI／Azure対応
- **Git identity**: 個別アカウントや個人環境へ依存せず、許可されたrepository設定を使う

## 旧環境設定（値・登録状態は記録しない）
- 旧DB接続設定: 値、接続先、登録状態を公開履歴へ記録しない
- 旧認証設定: secret値と運用状態を公開履歴へ記録しない
- 旧AI provider認証: 値と登録状態を公開履歴へ記録しない
- 実環境の現在状態は、許可された担当者がGitHub PR／CIと対象環境で確認する

## 注意事項
- deploy認証情報は安全な入力経路で扱い、値やshell履歴へ残る手順を文書化しない
- `.vercelignore` で `.env` を除外済み（ローカル .env が Vercel に含まれないように）
- 過去の認証情報露出可能性に対するローテーションまたは履歴対応は別承認で確認する
- 推測で CSV 列名を固定しない
- 独立請求項を主軸に据える
