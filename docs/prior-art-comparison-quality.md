# 指定文献の根拠付き比較（Issue #150）

## 操作と比較範囲

案件の「文献・請求項を選んで根拠付き比較」から、基準請求項と2〜3件の文献、各文献の請求項、文献名・版を指定する。保存原文を表示し、原本の番号・全文末尾・従属参照・画像や数式の欠落がないことを実行者が照合する。対応形式は、行頭の `【請求項1】` を連番で持つ日本語のnative text。請求項内の画像・数式マーカー、欠番、重複、不明な参照・循環、省略、欠損文字は要確認として停止する。PDF/OCRから消失した情報はテキストだけでは検出不能であり、原本照合の申告を機械的な完全性証明と呼ばない。

`draft_patents.parsed_text` と `prior_art_documents.claims_text` を直接採用する。旧 `extractedClaimsJson` の15,000文字入力上限・1,200文字fallbackや2,000文字先行文献入力は新しい比較の正本にしない。番号のないCSV/corpusテキスト等は推測して番号を付けず、原本に対応する資料の再取込みを案内する。全文とは指定請求項と必要な従属参照の全文であり、非選択請求項・明細書全頁・図面・検索網羅性を保証しない。

## 有限な計画と検証

既存managedの参照閉包、比較計画、全組合せ検査、引用一意性・原文一致・UTF-16位置の検証をadapterから再利用する。明示した文献をAI screeningで落とさない。同期APIは60秒、比較は全体50秒、個別35秒、最大3回、retry 0、最大2組/回、出力8,192 tokens。入力はsystem・schema・二重JSON escapeと余白を含めて事前検査する。完全な計画が収まらなければ最初の送信前に停止し、対象を絞るよう案内する。managed watchの41回枠・本番承認は継承しない。

すべての予定組合せを一度ずつ検証してから保存する。共通点・差分候補・未確認を分離し、両側の原文根拠を付ける。不存在や法的結論、risk段階を成功結果として提示しない。文字列一致は説明の意味の正しさを保証しないため、人による照合状態は `human_review_required` のまま。

## 保存・整合・旧結果

schema/migration変更なし。実在する基準請求項と先行文献の行に、既存 `matched_elements_json` のversion付き `priorArtComparison` envelopeを追記する。旧reader用キーは維持し、旧結果へ新しい全文検証済みの意味を付けない。案件画面は新形式を旧スコア一覧へ混ぜず専用の保存結果へ案内する。

保存snapshotには生成時点、原文/文献/版、対象範囲、引用位置、完全性の申告、未確認、operationId、canonical digestを保持する。全計画の検査後、比較専用transaction advisory lockと既存案件lockの下で、実IDの全結果行に`reserved`をcommitする。予約commitの応答確認前にはAIを送らない。AI後に既存案件lockとsource row lockを取得し、入力revision・予約operation/selection・行集合を再照合して、自分の予約だけをatomicに`complete`へ更新する。入力変更・不完全応答なら完了保存しない。以前の正常結果を削除しない。

未確定予約は再起動後も残り、同operationIdだけでなく同案件の新operationIdも送信を拒否する。時刻による自動失効や予算リセットはしない。成功COMMIT応答不明は同じoperationを読み戻すだけで、AIを再送しない。未確定結果は成果や正常0件として扱わず、別表示する。browserのpending operationもsessionStorageに保持する。未確定予約の解除APIは本範囲に含めず、実行者の利用状況・保存状態の照合と適用可能な再実行承認が必要になる。既存結果の再取得は引き続き可能。

文献の更新に伴う旧比較の無効化はlegacyだけに適用し、新snapshotは当時の由来を保持する。文献の明示削除ではversioned行のnullable FKを切り離し、実際に参照していたdocIdをJSONに保持して保存成果を残す。現在入力と異なる結果は明示する。案件全体の明示削除は既存契約のまま。未知version・不完全/競合groupは成功扱いせず、整合しない結果の帳票化を拒否する。

## 取得資料

PDFとCSVは保存snapshotのみから生成し、再取得もAI送信0。既存PDFKitの有限rendererとCSV数式注入対策を再利用する。テーマ、文献/版、指定請求項、生成時点、共通点、差分、根拠位置、未確認/限界と、採用した請求項・参照先の全文付録を含む。レイアウト都合の本文切捨てはしない。PDFのglyph/ページ上限等は明示的に失敗し、CSVまたは入力範囲の確認を案内する。

すべてのpage/APIは既存owner認証・CSRF・案件所属・no-storeを維持する。エラーは固定文言で、SDK/DBの生例外、資格情報、認証済みURLを公開しない。

## 実行と受入判定

- 通常の架空テスト: `pnpm test`、`pnpm lint`、`pnpm type-check`、`pnpm build`。
- 専用実アプリ受入: build後、`PRIOR_ART_COMPARISON_ACCEPTANCE=1` と `PRIOR_ART_COMPARISON_DB_TEST=1` を明示し、既存Playwright packageを `PRIOR_ART_PLAYWRIGHT_MODULE` へ指定して `pnpm test scripts/prior-art-comparison-acceptance.test.ts --maxWorkers=1`。`DATABASE_URL`等が親にあれば空PG作成前に拒否する。専用PG16へ既存migrationだけを適用し、loopback・専用Chrome profile・架空principal/AI/Blob transportを使用する。実Azure認証/Storageの受入ではない。TXT multipart→実parser→架空Blob transport/実DB→原文選択まで照合する。各テストの資源だけをlabel照合して回収する。
- 原文末尾/依存参照、保存/再表示/サーバー再起動、全PDFページ/CSV全行、誤引用・欠落、auth/CSRF、失敗時保全を確認し、fixtureの実アプリ一巡だけを `LOCAL_INTEGRATION_PASS` と呼ぶ。
- `PRIOR_ART_COMPARISON_TECHNICAL_GO` は、同headの許可済み実AIで公開資料2〜3件を比較し、原本と全引用・全組合せ・説明全件を独立照合し、必須CI/レビューも通過してから。専門家評価は別の `EXPERT_ACCEPTANCE_PENDING`。

## 承認・統合・rollback

実AIの適用可能な対象/用途/期間/回数/費用/回収まで一致する承認を確認できるまでは実送信しない。#148や過去Issueの一回枠・予約・unknown usageを流用しない。Local実装/帳票/レビュー/PRは先に完成させ、不足があれば一度の具体的な最小承認案にまとめる。

Draft PRと`codex:no-auto-merge`はTECHNICAL_GO、現headのCI/独立レビュー、#148の所有/統合順と固定imageへの非影響、App/Manual Job配備の費用/回数/codeSha/署名/停止/rollback条件がすべて成立するまで維持する。Production実受入は別判定。rollbackは本差分のrevert PRと承認済み通常deployで、旧部分比較の品質制限を明示する。元worktree、既存原本/DB/試用資材のreset・削除をrollbackと呼ばない。

比較結果の確定・文献削除時の切離しは同一transaction内のDELETE RETURNINGと同一実resultIdのINSERTで行い、既存のSELECT/INSERT/DELETE権限だけを使用する。比較tableのUPDATE権限やsequence再設定を追加しない。専用DBの非管理者roleからcomparison_resultsのUPDATEをrevokeして検証する。通常配備前の既存権限確認は別で行い、watch/import用LOGINを流用・拡張しない。
