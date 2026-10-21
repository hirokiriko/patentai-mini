# Issue #150：請求項ごとの引用座標を統一する有限完遂案

2026-10-21 JST。同じworktree・branch・Draft PR #151。これは**未承認の完成案**であり、新送信・署名・pin適用・統合・配備の許可ではない。

## 解消した停止要因と使える成果物

- 署名鍵は承認済みの1回生成を完了し、DPAPI CurrentUser・OWNER専用ACLの永続main／暗号化backupを別processで再取得・検証した。旧74署名も厳格検証済み。新鍵生成は不要。
- source v11では各入力請求項の必須cN欄に「非空の事実配列」または「完全一致引用付き未抽出理由」を一度だけ回答する。必須閉路が別欄で供給される請求項だけ追加配列を空にできる。独立したfactsとcoverageの二重回答をなくした。
- 追加事実の引用番号も請求項全文で数える。モデルが選ぶ狭いbasisと全請求項の座標の混在をなくし、後置された主語・条件を同じ請求項から引用できるようにした。原回答の補修、意味factの自動追加、他請求項探索、strict QA緩和はない。
- 配置関係の主語と参照対象、状態維持と開閉動作、流路順序と動作の時間条件を指示で分離した。判定器・target v1・保存v1・正常3callは不変更。
- 保存・再表示・再起動・11頁PDF・33行66セルCSV・再取得AI0の架空実アプリ9/9の有効な証拠を再利用する。実AI品質や本番受入の成功とは扱わない。

残る人の判断は、**新1351円有限programと、通常release用V8をAI5762円／総7312円へ最小整合し、最終head・独立レビュー済みdigest・有限operation IDへ正規に結ぶ承認**。累計上限6448／7998円、期限10月23日23:59 JST、既存鍵、通常枠、本番800円は変更しない。

## 終了した実AIと原因点検

[真正承認](https://github.com/hirokiriko/patentai-mini/issues/150#issuecomment-6306671257)に基づく旧1351円programは、第2診断164の確定品質FAILで終了した。159/160/164の計3送信・78.80400円を精算、新UNKNOWN0。165–168は未予約・未送信。usage／STOP ACK・全owned process回収・専用cleanupを確定した。[全件QA・精算記録](https://github.com/hirokiriko/patentai-mini/issues/150#issuecomment-6307525440)。

164はHTTP200/completed、input13351/output9244、37.84825円、約92.75秒。原文28facts・120引用をroot＋独立2名が全件照合し、引用不一致18、事実と未抽出理由の構造矛盾8請求項、配置主語欠落、状態維持の動作化、否定語内の部分一致、必要facts欠落を確認した。incompleteや32KB wire超過が今回の原因ではない。旧raw・失敗replay・凍結validatorは保持し、新コードで旧回答を救済しない。

引用基準と回答形式の不整合は除去したが、意味誤抽出の唯一の原因とは断定しない。表せる必要原子の欠落は品質FAILとする。同時性・減圧・排他等の現行型の限界を、既知誤りや正対照の見逃しの免責にしない。固定20欄24文14参照、誤り3/9/15/21、正対照7/8、留保5/11/17/23は不変更。全24文の正式判定は未成立、NOT_EVALUATED。

## 新しい有限再検証

新識別子 **ISSUE150_CLAIM_COORDINATE_1351_V1**。旧programの未使用権利・保留1325円案は転用しない。

1. 初回診断は原文＋固定対象の最大2送信。全件QA合格後だけ正常比較へ進む。
2. 初回の**確定した診断品質FAIL**に対し、同じ原文・固定対象・厳格QAを保つ具体的最小schema/prompt/locator修正後に限り、第2診断を最大1回。必要差分検証・SDK再測定・新head必須CI／独立2レビュー・正規再bindも同有限枠に含む。
3. 正常比較はprogram全体で合計1回・最大3送信。初回診断合格なら第2診断を使わず、正常予約後は診断へ戻らない。Local最大7送信・request retry0。
4. UNKNOWN、incomplete、timeout、ACK／書込不明、正常予約後の失敗、第2診断FAILで全停止。新UUIDや旧枠で再開しない。未知usageは全予約を保持する。

| 段階 | 入力上限 | 出力上限 | 予約 | 無通信SDK保守上界 |
|---|---:|---:|---:|---:|
| 診断原文 | 60,000 | 16,384 | 175円 | 55,544 bytes |
| 診断対象 | 74,000 | 22,528 | 231円 | 71,213 bytes |
| 正常原文 | 60,000 | 16,384 | 175円 | 55,544 bytes |
| 正常生成 | 56,000 | 8,192 | 116円 | 54,828 bytes |
| 正常対象 | 90,000 | 22,528 | 248円 | 88,174 bytes |

診断406円×最大2＋正常539円＝全予約**1351円**。model/default/low・出力は維持。実SDK＋framing、最大正常草稿とdescriptor／scope余裕を含め測定。schema89 properties／深さ5、全入力19請求項65片、wire32KB／witness16KB／descriptor6KB、合計48facts・512locatorの制限を維持。再測定で枠を超えたら送信前停止し、原文・対象・必要条件を削らない。

request210秒／operation230秒／製品HTTP本文完了240秒／同時1／親1800秒／runner1740秒／QA待ち900秒を維持。期限**2026-10-23 23:59 JST**、開始余裕Local6時間／forward240分／本番180分。期限後はstatus／review-reconcile／settlement-reconcileのみ。

## 累計費用と正規署名

台帳134行・67予約・45867bytes、SHA256 `abc94095085a60c04faf1033b146d15c54eef4f11daeb680fe5d0474f9ab3502`。既知実費1606.48840円＋UNKNOWN12件2832円＝現AI4438.48840円。UNKNOWNは全額保持する。

| 項目 | 保守額 |
|---|---:|
| 現AI実費＋UNKNOWN | 4438.48840円 |
| 新Local全予約 | 1351円 |
| 既承認本番AI留保 | 650円 |
| AI上界 | **6439.48840円** |
| 本番非AI | 150円 |
| 配備／rollback留保 | 1400円 |
| 総上界 | **7989.48840円** |

既承認上限**AI6448円／総7998円**内、余裕8.51160円。予約式ceil((5×input＋30×output)×220/1000000)、usage精算(2.5×input＋15×output)×220/1000000。全7送信を既知usageで精算した最大Local実費672.96240円。

全件QA・全精算後だけのrelease上界はAI5761.45080円／総7311.45080円。既存V7の5685／7235円を76.45080円超えるため、新しい**V8を5762／7312円**へ各77円だけ増額する。累計上限の変更ではない。V1–V7の履歴・消費済み回数・UNKNOWN・ordinary poolは保持し、V8→旧scope downgradeを拒否する。

既存custodyと旧74署名のreceiptは元の真正owner digestで再利用する。新programの真正owner、新head、独立レビュー済みunsigned digest、列挙有限operation IDだけをV8／Local pinへ正規に結ぶ。承認前に署名・pin適用はしない。新鍵・rotation・App/Job鍵env変更なし。

## 通常統合・配備から本番一巡

診断合格後、実アプリの正常3callで3公報4組を処理する。全新記述・全理由・全引用をroot＋独立2名で原文QAし、生成→最終判定→保存同一性、保存／再表示／再起動、全PDF頁の目視と順序、全CSVセル、再取得AI0を確認する。

TECHNICAL_GO、最終head CI／独立レビュー、正規署名、通常費用・回数・#148非影響の全条件成立時だけ通常Squash Merge→既存通常配備へ進む。配備1＋必要時rollback1／合計1400円／Job起動0、月次38331円／jobs25／3000分／forward9、既存9単位・pool・旧#140 allowanceは維持。新auth・DB/Storage資格情報・identity・ACL・#148試用は変更しない。

既承認のApp `MANAGED_KOHO_UPLOAD_SETTINGS` と `MANAGED_WATCH_WEB_SETTINGS` のcode/imageと対応pricing/profileだけを通常配備へ整合する。forward後PATCH1、必要時rollback後PATCH1、再送0。前後値とetagを保全し、確認不能／ACK不明で再PATCHしない。App/Jobの署名鍵envは触らない。

既承認本番1回**800円（AI650＋非AI150）**：常設App/API・DB/Blob・固定URLで同じ専用1案件に公開3TXTを入力→4組の実AI比較1回（最大3送信・再送0）→全件QA→保存／再表示→全PDF/CSV→再取得AI0→当該案件と3Blobだけcleanup／readback。受付caseId・公報ID・Blob名を固定し、他データやtrial資源は消さない。既存Local-PC非依存証拠を再利用し、PC電源操作を新条件にしない。

品質不合格やUNKNOWN等では後続を止める。本番で取得した実結果もすべて検証し、単なるHTTP成功を受入合格にしない。運営者の恒久クラウド一巡、実AI正常成果物、専門家受入は未達。

## 無課金検証と残る判断

新請求項schema／全引用座標、配置と状態維持の手書き正負例、旧v10拒否、foreign claim／元fixture basis外拒否、V8の署名・金額・消費済み回数・downgradeを含む対象検証649件と実SDK無通信計測がPASS。通信・新有料送信0。型・lint（error0、fixtureの未使用分解変数warning2）・隔離buildがPASS。V8追加後も旧74署名の無通信再検証がPASS。最終head CI／独立2名レビューの結果とdigestはIssue完成記録へ結ぶ。保存／帳票・親・不変更コードの有効な検証は再利用する。

初回の対象テストは旧fixture参照3件の準備不備で失敗し、修正後成功した。config指定なしの過去snapshot誤選択は中止し、成功数に含めない。V8テストのunion型用日付不足はfixtureを修正し、型検査と対象テストを確認。最初のbuildはGoogle Fonts取得制限で失敗し、通常ネットワークの隔離buildで成功した。pending adapter準備時の上限数値・旧束縛の不一致は独立レビューで修正し、承認前停止・費用・履歴拒否を再確認した。失敗記録は保全する。これらの無課金成功は実AI意味品質や送信admission GOではない。

追加判断が必要なのはIssue #150 §4B/4C・§7による。旧programは第2診断FAILで全停止し、新しい有限送信権がない。また全精算後の正規releaseだけV8への最小金額整合が必要。既承認の通常工程・期限・累計上限・鍵・本番確認を承認し直す質問ではない。
