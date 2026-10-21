# Issue #150：引用基準の整合後の有限完遂案

2026-10-21 JST更新。同じLocal root、worktree、branch、Draft PR #151。

## 現在：真正承認済み1351円programの第2診断準備

OWNERは前の保留を取り消して承認した。正本はIssue #150 §0-Mと
[真正承認6306671257](https://github.com/hirokiriko/patentai-mini/issues/150#issuecomment-6306671257)。
初回159/160は40.95575円精算、新UNKNOWN0。root＋独立2名全件QAはFAIL、
正常161–163は未予約・未送信、停止ACK・全owned process回収・限定cleanup完了。
[原応答・QA・精算の保全記録6306979817](https://github.com/hirokiriko/patentai-mini/issues/150#issuecomment-6306979817)。

159の必須閉路と全45引用は位置検証に適合した。一方、候補側の必要な配置・固定モード・
熱作用等が未抽出。160は全欄atoms0に加え、複文partの文境界横断とreservationの
topic/basis不一致でdomain拒否。正式な24文判定・理由は未成立で、品質合格ではない。

修正は既存の比較専用抽出指示とschema説明に限定する。択一親参照と自請求項の事実を
区別し、canonical省略を供給済みの完全一致集合だけに限定する。未抽出という報告だけを
表現不能理由にしない。targetは既存unitStarts内で分割し、名詞の未確認題目だけを
引用する具体例を示す。判定器・厳格検証・原文・固定24文・保存v1は不変更。
架空の択一親参照下の自請求項と、二文の事実／名詞留保を実schemaからdecodeまで確認する。

承認済み第2診断406円＋正常539円＝残945円。必要差分検証、SDK再測定、
新head CI／独立2レビューと正規再bind後だけ実行する。初回の確定品質FAILに対する
この最小修正は同program内で許可済みであり、新たな人の判断は現在不要。
最大残5送信・retry0。第2診断FAIL、UNKNOWN/incomplete/timeout/ACK・書込不明、
正常予約後の失敗で全停止。旧枠や新UUIDで再開しない。

既知1568.64015円＋UNKNOWN2832円＝4400.64015円。残Local945円と本番AI650円で
AI上界5995.64015円、非AI150円と配備/rollback1400円込み総7545.64015円。
上限6448／7998円、期限2026-10-23 23:59 JST、V7、通常枠、本番1回800円は不変更。
全条件成立時だけ通常統合・配備・本番一巡へ進む。TECHNICAL_GOと正常実AI成果物は未達。

以下は1351円案の承認前提案と過去の実行履歴。各時点の「未承認」「人の判断待ち」は
現在の停止指示ではない。旧未使用枠を転用しない。

## 最新：解消した停止要因と使える成果物

- 旧署名74件の厳格な履歴検証を完了した。既知PR146形式の互換読取だけを許し、
  activeな旧Issue139操作は復活させない。
- 承認済みEd25519鍵を1回生成し、DPAPI CurrentUser・OWNER専用ACLの永続main／
  暗号化backupを別processで再取得・署名検証した。新鍵生成は不要。Local pinは未適用。
- 必須閉路で入力の入口／出口ヒントと出力basisの引用番号の基準が異なる不整合を修正した。
  同じ請求項全文を入力・schemaで共有し、前置された同名語や経路外の後置条件も保持する。
  原応答149／154の補修、意味factの自動追加、検証の緩和は行わない。
- 独立に手書きした架空原文／対象文の弁open-close、熱作用＋inside、固定mode＋upstreamを、
  実schema・decode・比較・説明まで接続した。根拠の欠落、条件・mode・位置の変更、
  候補側の根拠流用を拒否する。AIの意味抽出品質が証明されたとは扱わない。
- 既存の架空実アプリ9/9、保存・再表示・再起動、11頁PDF・33行66セルCSV、再取得AI0の
  有効な証拠を再利用する。保存形式・reader・画面・帳票コードは変更していない。

残る人の判断は、新しい1,351円有限programと、その最終head・review・operation IDを
既存V7 release／Local pinへ正規に結ぶ承認。累計上限・期限・V7金額・鍵・通常枠の増額は不要。
第一目標の「恒久クラウドで入力→実AI比較→根拠確認→保存・再表示→PDF/CSV取得」は未達。

## 最新：終了した実AIと原因点検

承認済み1,522円programは第2診断154の品質FAILで終了した。
149はHTTP200/completed、input13,210/output11,652、45.71710円。
154はHTTP200/completed、input13,263/output9,360、38.18265円、88.51秒。
合計83.89975円を精算済み、新UNKNOWN0。原文診断以外は送信していない。
STOP ACK、全owned process回収、対象DB/container cleanup、残存0を確定した。
原raw・usage・失敗replay・root＋独立2名の全件QA・台帳prefixを保全した。

149の45命題・240引用には13不適合引用があった。154の14命題・74命題引用には
2不適合引用が残り、coverageの8引用は完全一致していた。154の2件は閉路出口のoccurrence超過。
全19請求項の形式coverageはあり、incomplete・出力超過・timeoutではなかった。
入力ヒントは入口／出口自身の小さいpartで数え、出力はモデルが選んだ別basisで数えていた。
この不整合は除去したが、誤出力の唯一の原因と断定しない。

154では既存型で表せる発熱、inside、固定mode、弁動作も欠落していた。
一方、固定24文には群の総括、抽象的な制御、減圧、動作の同時性、複雑な留保など、
現行の狭い表現ではそのまま確定できない箇所もある。この二つを混同しない。
全19請求項の全述語形式化や新しい汎用基盤へ広げず、表せる原子の欠落はQA不合格とする。
表せない強い断定を弱いhas／部分集合へ置換して合格にしない。

固定24文・14参照は不変更。既知4誤り3/9/15/21は正しい原文理由と個別検出が必要。
正対照7/8は固定mode／上流配置／選択肢と必須の区別を保持する。
留保5/11/17/23を誤り扱いにせず、留保前の事実を丸ごと消さない。
2/12/18の集合総括、4の制御総括、13/14/17/20の減圧等、19/20の同時関係、
14の共有主語と後置修飾は、不適切な補完をせず全件QAで照合する。
型の制約を正対照の欠落や4誤りの未検出の免責にしない。現在は全24文NOT_EVALUATED。

## 最新：1,351円の有限programと費用

期限は既承認の **2026-10-23 23:59 JST（2026-10-23T14:59:00Z）** を維持する。

1. 診断は初回1回。確定品質FAILへの具体的な最小修正、必要差分検証、
   新headの必須CI・独立2名レビュー・正規再bind後に限り第2診断を1回認める。
2. 診断全件QA合格後、正常比較は合計1回だけ。Local全体は最大7送信、request retry0。
   初回診断が合格すれば第2診断を使わない。正常予約後は診断へ戻れない。
3. UNKNOWN、incomplete、timeout、ACK／書込不明、正常開始後の失敗、第2診断FAILで全停止。
   新UUIDや旧未使用枠で再開しない。時間超過・未知usageは全予約を保持する。
4. 同じ原文、固定対象、model/default/low、出力、時間、厳格QA、保存v1を保つ。
   この有限枠内の最小schema/prompt/locator修正だけを第2診断へ含める。
   再測定が下表を超えた場合は送信前停止し、原文・対象・必要条件を削って合わせない。

| 段階 | 今回の入力上限 | 出力上限 | 全予約 | 実SDK保守上界 |
| --- | ---: | ---: | ---: | ---: |
| 診断・原文 | 60,000 | 16,384 | 175円 | 55,811 bytes |
| 診断・対象 | 74,000 | 22,528 | 231円 | 70,668 bytes |
| 正常・原文 | 60,000 | 16,384 | 175円 | 55,811 bytes |
| 正常・比較生成 | 56,000 | 8,192 | 116円 | 54,828 bytes |
| 正常・対象 | 90,000 | 22,528 | 248円 | 87,629 bytes |

診断406円×最大2＋正常539円＝**1,351円**。実送信bytes＋8,192とusage両方を確認する。
これは今回の固定資料の有限送信上限で、製品90,000上限や本番650円予約を縮める変更ではない。
source schemaは99 properties／深さ5。原文19請求項65片、固定20欄24文14参照は同一。
SDK計測はfetch stubだけでnetwork0。最大正常草稿と完全descriptor／scope余裕を含む。

request210秒、operation230秒、製品API本文完了240秒、同時1、親1,800秒、runner1,740秒、
診断QA待ち900秒を維持。Local開始は期限まで6時間、forward開始240分、本番開始180分以上。
期限後はstatus／review-reconcile／settlement-reconcileだけ。

台帳128行・予約64件。既知実費1,527.68440円＋旧UNKNOWN2,832円＝4,359.68440円。
旧UNKNOWN12件は全額保持する。停止済み1,522円programと保留1,325円案は新送信権ではない。

| 項目 | 保守額 |
| --- | ---: |
| 既存実費＋UNKNOWN | 4,359.68440円 |
| 新Local全予約 | 1,351円 |
| 既承認本番AI留保 | 650円 |
| AI上界 | **6,360.68440円** |
| 本番非AI留保 | 150円 |
| 配備＋rollback留保 | 1,400円 |
| 総上界 | **7,910.68440円** |

累計上限 **AI6,448円／総7,998円は変更しない**。余裕は各87.31560円。
予約式 `ceil((5×input＋30×output)×220/1,000,000)`、
既知usage精算 `(2.5×input＋15×output)×220/1,000,000`、reasoningは出力内。
全7送信を既知usageで精算した最大Local実費は672.96240円。
全件QA・精算後のrelease上界はAI5,682.64680円／総7,232.64680円で、
既存V7のAI5,685円／総7,235円内。V8追加や旧V1–V7の金額変更は不要。

## 最新：既存鍵・通常工程・本番一巡への接続

既存鍵custodyと旧74署名検証は、旧真正承認のdigest・receipt hashを固定して再利用する。
新ownerは新programの送信権へ別に束縛し、旧custody記録を書き換えない。
新owner証拠、独立レビュー済みunsigned digest、最終head、列挙operation IDだけを
Local管理pin／V7へ正規に結び直す。新鍵生成・rotation・App/Job鍵env追加はしない。
旧V1–V7、消費済み回数、旧署名、台帳とUNKNOWNを保持する。

後段の「通常統合・配備と設定整合」「既承認の本番確認1回と受入成果物」の具体手順は
既承認工程として維持し、新programの実精算・全件QA・最終headへ結ぶ。
月次38,331円、jobs25、minutes3,000、forward9、既存9単位／pool、#140 allowanceは維持。
配備1＋rollback1・1,400円・Job起動0、App二設定のforward PATCH1／rollback PATCH1・retry0も不変更。
新auth、DB/Storage資格情報、identity、ACL、#148試用資源は変更しない。

本番は800円（AI650＋非AI150）、専用1案件へ公開TXT3件を入力し、同じcaseIdで4組を
実AI比較1回（最大3送信／再送0）→root＋独立2名の全件QA→保存・再表示→全PDF/CSV→
再取得AI0→専用案件と3Blobだけのcleanup／readbackまで。固定URL・常設App/API・DB/Blobを使う。
Local PC非依存の既存証拠は再利用し、PC電源操作を新しい条件にしない。
合格条件が揃った時だけ通常Squash Merge・配備・本番確認へ続行する。
実AI意味品質、正常成果物、通常統合・配備、本番一巡、専門家受入は現在未達。

## 最新：無課金検証

今回の製品変更は比較専用4ファイル。対応3テストファイルと本書を更新した。
関連233件・新schemaの無通信SDK計測はPASS。独立2名の差分読取で未解決P0–P2なし。
型、lint、隔離製品build、必須CIと最終headの独立レビューは完了時のIssue記録へ結ぶ。
実行はpnpm対象vitest、変更ファイルeslint、snapshot tsc／next build、git diff --check。
初回の追加回帰は対応外の前置条件を選んだ不備、接続試験はvalidateAnswerへの余計な欄で
失敗した。テスト入力だけを修正し、失敗記録と最終成功を区別して保持した。
旧有効な保存・帳票・親・台帳・署名の検証は変更範囲を照合して再利用する。

---

## 以下は旧1,522円案と実施経過の履歴

過去時点の未承認／未実施表記や金額は当時の記録であり、新送信権ではない。

2026-10-21 JST作成。Issue #150 §0-Jと進行指示comment 6294248189に対応する。
同じLocal worktree・`codex/issue-150-prior-art-quality`・Draft PR #151を使用する。
この文書は未承認の案であり、送信・期限延長・新鍵生成・pin変更・配備を許可しない。
保留された1,325円案と、停止済みprogramの未使用枠は再利用しない。

## 先に使える成果と残る判断

- 比較v10は完成済みで、今回の比較・画面・保存・帳票コード変更はない。
  原文一覧・参照・位置をコードで確定する責務と、意味をAIが抽出する責務を、
  失敗139/144と現実装で一度照合した。追加の汎用パーサーや評価基盤は作らない。
- 架空AIによる保存結果、11頁のPDF、33行66セルのCSVは取得・点検可能。
  保存／再表示／再起動、全頁の内容・順序・描画、CSV全セル、再取得AI0の有効な証拠を再利用する。
  これは実AIの品質合格や本番受入ではない。
- 鍵の復元先不明を解決対象に含めた。旧署名履歴を保持し、今回だけの新鍵を
  独立に確認したreview digestに限定する互換処理を実装した。実鍵とpinは未変更。
- 残る人の判断は、この有限program、期限、累計費用、最小鍵更新と通常配備に伴う
  二設定の整合を一括承認するかどうか。既承認の通常工程を承認し直す案ではない。

最初の完了目標は、運営者が既存の恒久クラウドで、同一案件の入力→実AI比較→
根拠確認→保存・再表示→PDF/CSV取得を一巡できること。
TECHNICAL_GO、実AI正常結果、本番の一巡は現在未達。固定24文はNOT_EVALUATED。

## 一度の品質原因点検

139は36命題・171引用中、反復位置不明27件と選択範囲にない引用14件で失敗した。
144は41命題・151引用を返したが、引用4件が不適合で、
入力19請求項中14件のcoverageと必須閉路2件の回答が欠けていた。
両回はcompletedとusageを取得しており、この2件の原因をtimeoutや出力上限とは扱わない。
別の過去timeoutの原因は未特定のまま保持する。

現v10は原文digest・請求項・part座標・参照DAG・catalog IDをコードで生成し、
AIの回答schemaへ固定する。全入力請求項のcoverage、既知閉路の回答も必須にした。
AIには意味・条件・経路、根拠範囲、実際に選んだ引用と反復位置を回答させる。
反復箇所の選択は意味に関わるため、コードが都合のよい位置へ補修しない。
現promptにはmode、内外、動作主体、経路入口・出口、条件、熱の具体的な注意も既にある。

従って追加の比較コード変更は不要と判断した。引用位置の一致は意味品質の証明ではない。
原本22請求項／入力19請求項65片、固定20欄24文14参照、既知4誤りと正対照を維持し、
旧rawの修理、原文削減、失敗を除いた部分合格は行わない。

## 有限の再検証と新期限

案名は `ISSUE150_COMPLETION_1522_V1`。
新絶対期限は **2026-10-23 23:59 JST（2026-10-23T14:59:00Z）**。
期限は有料Local、本番確認、通常配備・rollback・限定cleanupまで共通とする。
旧期限の書換えではなく、新しい真正承認が必要である。

1. Local診断は初回1回。確定した診断品質FAILの原因を全件点検し、
   具体修正・無課金差分検証・新headの必須CI／独立2名レビューが済んだ場合だけ第2診断を1回認める。
2. 診断の全件QAが合格した場合、正常比較は合計1回だけ。
   初回診断が合格すれば第2診断は使わない。Local全体は最大7送信、request retryは0。
3. 各小修正で新しい有限programを作らず、この1回の修正機会に含める。
   同じ原文・固定対象・model/default/low、意味の厳格検証、時間・出力・保存形式を保持する。
   schema/prompt/locatorの必要な最小修正に限定し、最終headと再測定した入力を結ぶ。
   上限超過や方式・対象の拡張は本案に含まれない。
4. 正常比較の最初の予約後は、品質FAILでも第2診断に戻れない。
   UNKNOWN、incomplete、timeout、ACK／書込不明、第2診断FAILでprogram全体を停止する。
   生raw、usage、予約・UNKNOWN、停止とcleanup記録を保持し、新UUIDで再開しない。

| 段階 | 入力上限 | 出力上限 | 1送信の予約 |
| --- | ---: | ---: | ---: |
| 診断・原文 | 90,000 | 16,384 | 208円 |
| 診断・対象 | 90,000 | 22,528 | 248円 |
| 正常・原文 | 90,000 | 16,384 | 208円 |
| 正常・比較生成 | 90,000 | 8,192 | 154円 |
| 正常・対象 | 90,000 | 22,528 | 248円 |

診断456円×最大2＋正常610円＝**全予約1,522円**。
入力予約を既存の製品上限90,000へそろえ、有限修正に伴う小さなprompt増を最初から含める。
実入力を増やす変更ではない。現v10の無通信SDK計測上界は
55,800／70,668／55,800／54,828／87,629 bytesで、対応sourceは不変。
各入力は実送信bytes＋8,192の保守上界とusageの両方で確認する。
出力のreasoning tokensは出力枠に含む。

request 210秒、比較operation 230秒、製品API 240秒、保護親1,800秒、
runner 1,740秒、診断QA待ち900秒を維持する。
Local有料開始は共通期限まで6時間以上、通常forward開始は240分以上、
本番確認開始は180分以上を残し、不足時は新しい操作を開始しない。
forward40分＋再束縛30分＋本番45分＋必要時revert validation40分＋
rollback40分＋再束縛30分＝225分にIO余裕15分を加えたもの。
本番開始にも45分＋rollback側110分とIO余裕を残す。未使用の時間枠を送信権へ転用しない。
通常workflowは各40分、forward＋rollback合計80分を維持する。

## 総費用と既存月次枠

過去台帳124行・予約62件、既知実費1,443.78465円、UNKNOWN2,832円を全額保持する。
既存exposureは4,275.78465円。過去失敗139＋144の76.73215円はこの既知実費に含む。

| 項目 | 保守額 |
| --- | ---: |
| 既存実費＋UNKNOWN | 4,275.78465円 |
| 新Local全予約 | 1,522円 |
| 既承認本番AI留保 | 650円 |
| AI上界 | **6,447.78465円** |
| 本番非AI留保 | 150円 |
| 通常配備＋rollback留保 | 1,400円 |
| 総上界 | **7,997.78465円** |

累計上限案は **AI6,448円／総7,998円**。
最後の真正承認6,172円／7,722円から各276円増。
未承認の1,325円案との比較では各197円増だが、その枠を承認済みとして転用しない。
今後の全予約は合計3,722円（Local1,522＋本番800＋配備等1,400）。

予約は既存の税・為替込み保守式 `ceil((5×input＋30×output)×220/1,000,000)`。
既知usageは既存評価式 `(2.5×input＋15×output)×220/1,000,000` で精算する。
全7送信が既知usageで終了する場合のLocal最大実費は758.76240円。
全件合格・全精算後のrelease上界はAI5,684.54705円／総7,234.54705円で、
新署名scope V7だけAI5,685円／総7,235円へ整合する。
旧V1–V6、旧金額、消費済みforward/rollback、UNKNOWNは変更しない。

通常配備等の1,400円は既存のforward255円＋rollback850円、
二設定・profile整合等の管理分250円（各125円×2）、余白45円に分けて保守留保する。
管理分は既存117.22874円モデルのBlob保持だけ1→32MiB、転送100→256MiBへ増やした
各124.145031円を切り上げたもの。各phaseで30分／2vCPU・4GiB、
HTTP1,000、Blob書込・list1,000／読込1,000、ログ100MiB、30日保持を上限とする。
旧保守モデルのDB／WAL／backup分も差し引かず保持する。親が数量と累計を監視し、
新Job・AI・追加image buildをこの管理分で実行しない。
鍵生成・DPAPI保管・Local pinはクラウド費用0。
本番非AIは既存固定数量の見積117.22874円に対して150円を留保する。
30分のApp計算、HTTP1,000、DB16MiB／WAL128MiB／backup256MiB、
Blob1MiB／read-write各1,000、転送・ログ各100MiBと30日残留分を含む。
AI、月次pool、releaseの内訳を二重使用しない。

10月21日00:29 JSTの読取では、既存stateの74 administration／101 operations、
月次forecast38,331円を保持。月次補足は未適用で、
jobs25／minutes3,000／forward8に対し通常上限24／2,880／8である。
既承認の補足 **月次38,331円、jobs25、minutes3,000、forward9** のみ正規署名で適用する。
残りの9単位、pool、既存#140 allowance（10月31日まで有効）はそのまま保持する。
書込直前に新鮮なstate・履歴・実消費・poolを再照合し、不足なら停止する。

## 復旧不能な既存署名鍵の最小置換

旧鍵の既知参照先不在とOWNERの「復元先不明」は確定済みで、同じ探索を繰り返さない。
実施者は現Local root。OWNERが本案の鍵更新を真正承認した後に限り、次を行う。

1. 旧公開鍵、owner／target binding、既存管理履歴の連続sequenceとenvelope digestを固定し、
   旧署名全件と連鎖を検証する。台帳・旧署名・旧公開鍵を上書きしない。
2. Ed25519鍵をLocalメモリ内で1回生成する。秘密PKCS8は非表示pipeのみで扱い、
   Windows DPAPI CurrentUserで暗号化して、Temp・repo・OneDrive外の永続保存先へcreate-only保存する。
   mainと暗号化backupをOWNER専用ACLで保管し、固定保管先識別子をLocal記録へ残す。
   別の短命processでmain／backupの復号、公開SPKI／SHA256一致、署名の自己検証を確認してから使う。
   DPAPI復元は同じWindowsユーザー環境に依存し、別PCでの復元を保証するものではない。
3. 既存署名helperの秘密鍵入力を、この固定保管先からのメモリ／pipe取得へ置換する。
   新しい独立確認済みreviewの正規digestだけを署名し、既存validatorで署名を再検証する。
   argv・標準出力・ログ・GitHub・環境変数へ秘密を出さない。
4. `ISSUE150_KEY_REPLACEMENT_V1` のLocal管理pinを明示注入する。
   固定した旧履歴prefixだけ旧鍵で検証し、それ以後は新鍵で、
   OWNER証拠digest、独立レビュー済みunsigned review digest、許可operation IDを照合する。
   デフォルトenv loader、HTTP、stdin、Blobから置換pinを取り込む入口は追加しない。
5. 新鍵の用途は今回の正規月次補足、V7 forward／必要時rollback、
   対応するprofile activateと精算だけ。最大16 administration reviews、
   最大16 settlement reviews、最大4 operation IDsというschema上限の内側でも、
   実際には独立確認した必要件数と、forward1件、必要時のrevert PRの
   pr-push／pr-open validation各1件、rollback1件の最大4 operation IDsだけを列挙する。
   精算signerには、そのうちforward／rollbackの固定2 IDsを別に渡してsubset一致を確認する。
   新しいJob／watch開始権を与えない。

新旧どちらかの鍵なら通るfallbackは設けない。期限後は既存書込の照合・履歴読取に限定する。
新しい履歴を書く前ならLocal pinを元へ戻せる。新鍵の履歴を書いた後は、
新公開鍵と対応記録を残したまま正規rollbackを使う。台帳巻戻しや旧鍵への偽装は行わない。
暗号化秘密と公開検証記録はcleanupで消さず、再取得可能な状態で保持する。
鍵復号・pin・旧署名のどれかが確認できなければ、有料Localを始める前に停止する。

## 通常統合・配備と設定整合

本番は既存resource group、App `ca-patentai-mini`、
Manual Job `issue123-import-cedbbb648b57` だけ。Jobはimage更新のみで起動0。
Local全件QA、正常保存・再表示・帳票、TECHNICAL_GO、最終headのCI／独立レビュー、
競合・未解決必須指摘なし、#148非影響、月次9単位／pool、正規署名を満たした時だけ進む。
既承認の通常Squash Merge・forward1回／rollback1回という工程は維持する。

既存watchは `codeSha`、build SHA、Job image、pricing policy、active profileの一致を要求する。
従ってimageだけを更新して旧設定を残す案にはしない。既存Issue #139の
successor／runtime projectionの手順を参照し、#150の新しい承認と実測値へ限定して再bindする。
旧helper内のIssue番号・head・履歴件数・UNKNOWN0の固定値を流用しない。

- deployment後のmerge SHA／tree／image digest／App・Job metadataを採取し、
  既存measurementと旧GOの原証拠を保った互換code更新証拠へ結ぶ。
- 配備前のmonth補足は現profile Q0に結び、正規release admission後に通常配備する。
  配備後の新pricing P1は旧P0のcodeSha／imageのみ整合し、単価・数量・計測・既存期限を引き継ぐ。
  profileはそのpricing digestとGO evidence digestだけを改版し、消費・pool・案件枠を維持する。
- 配備後のmonthで通常補足のprofileDigestだけを新profile Q1に結び、
  新GO digestをLocal管理pinへ設定して正規署名reviewでQ1をactivateする。
  既存#140 completionAllowanceは旧profileDigestを含め完全一致で保持する。
  補足は `ISSUE150_STANDARD_MONTH_V1`、month、ownerApprovalDigest、profileDigest、
  monthlyCapYen38,331、jobs25、minutes3,000、forward9に限定する。
- Appの `MANAGED_KOHO_UPLOAD_SETTINGS` と `MANAGED_WATCH_WEB_SETTINGS` の二設定だけを、
  前者の`codeSha`／`job.image`、後者の`codeSha`／`image`と、それらが参照する
  pricing policyへ整合する。既存executorのforward PATCH最大1回、
  必要時rollback PATCH最大1回、phase毎300秒・ARM読取最大12・retry0を使う。
  新たなauth・DB・Storage資格情報・identity・ACLを変更しない。
- 設定変更前のimage／二設定／profileとsourceを固定する。rollbackは本変更のsourceを
  打ち消すrevert PRの正規validation・merge／配備経路を使い、実際のrollback squash SHAと
  imageからP2／G2／Q2を作り、month／activate／二設定をその実SHA・imageへ再bindする。
  新しいbuildを旧SHAと偽らず、旧imageと旧profileへ見かけ上戻さない。
  共有stateのリセットや、#148試用のimage・profile・DB・保護journalへの変更は行わない。

この二設定の限定更新とLocal鍵更新は、§7の一般的な設定・秘密変更禁止に対する
今回だけの明示的な承認対象として一括案に含める。
署名公開鍵をApp／Job環境変数へ追加する必要はない。
#148の完成や新しいwatch実AI受入は追加の依存にしない。
既存GOの再利用と配置・設定の一致は確認するが、未実行のwatch開始を新たな成功とは報告しない。

## 既承認の本番確認1回と受入成果物

800円（AI650＋非AI150）、公開3公報4組、専用1案件、実AI最大3送信・再送0を維持し、
本案の期限・最終headへ結ぶ。新しいテスト案件を使うこと自体を成功とは扱わない。

1. OWNER認証の固定URLから専用案件を作り、公開TXT3件を入力する。
   その同じcaseIdで原文・組合せを選択し、比較開始は1回だけ。
   クリック前に650円を全予約し、製品がPOST内で作るoperationIdと選択を保存して送信を許可する。
2. 返答とusageを保持し、root＋独立Local2名で全4組の判定・説明・引用・条件・経路を原本照合する。
   保存結果・再表示結果の同一性、全PDF頁とCSV全行全セル、再取得の内容一致と追加AI0を確認する。
3. 専用案件とその3個の公開TXT Blobだけを既存経路でcleanupし、
   Blob削除3／失敗0、案件再読取404を確認する。曖昧なwriteは再送せず照合して停止する。
   帳票と秘密を含まない受入証拠は保持し、既存業務データは削除しない。

固定URL・OWNER認証・常設App/API・DB/Blobの保存を実際の一巡へ結ぶ。
既存のLocal PC非依存証拠は再利用し、OWNERのPC電源操作や別端末を新しい必須条件にしない。
過去の架空試験ではuploadと比較が別caseだったため、その証拠だけで本番の同一case一巡を合格にしない。
本番品質FAIL・UNKNOWN等では後続実AIを停止し、再比較を追加しない。

## 差分検証と引継ぎ

今回の製品差分は署名・台帳の2ファイルと対応テスト2ファイル。
V7、旧署名prefix、新鍵用途制限、month／settlementの改変拒否、
ACK不明後の期限切れ照合を確認した。署名／台帳405件、費用・期限の新差分4件、
型確認、変更ファイルlint、製品buildはPASS。
build IDは `2u4CYeOSe9ZQNIbdolzDc`。
比較881件、guard105件、Windows親8・再開24・有限2枠、
架空実アプリ9/9と全帳票証拠はsource一致を確認して再利用する。

実行コマンドはpnpmの対象vitest、scoped `tsc --noEmit`、変更ファイルeslint、
隔離snapshotの `next build`、pending gate／費用の無通信確認、`git diff --check`。
初回の新テストでは未正規化fixtureの署名不一致と型union不一致を修正した。
snapshot junctionはsandbox権限で失敗し、同じ範囲の許可された実行で成功した。
失敗ログは成功証拠と区別して保持する。旧1,325円案と124行の台帳は不変。

新実AI、鍵生成、pin適用、通常統合・配備、本番書込は今回0。
CIと独立レビューは最終PR headに照合し、その記録をIssue #150へ付ける。
真正承認後は同じ有限範囲で進め、未承認・期限切れ・実品質未証明を成功として引き継がない。

## 承認後に確認した旧署名履歴の互換修正

2026-10-21、OWNERは完成案を一括承認した。上記の未承認表記は準備時点の記録である。
有料Local開始前の旧74署名確認で、PR #146の過去の正規forwardに含まれる
Issue140 allowanceを、history decoderが拒否する不整合を確認した。
以前の架空fixtureがallowanceなしであり、実物の形式との差を検出していなかった。

既知のPR146・head・base・forward・255円に固定したhistory専用分岐を追加する。
旧署名、owner/target、digest、参照元、JST月、有効期間を厳格に検証する。
active apply/reconcileでは従来どおりIssue139を拒否し、過去の操作権を復活させない。
取得済み署名原本をLocalで保持し、無通信の再検証へ使う。
比較コードと有効な比較・保存・帳票の証拠はそのまま再利用する。

## 初回149の確定品質不合格と有限枠内の修正

承認済みprogramの149はHTTP200/completed、88.63秒で応答し、
input13,210/output11,652、45.71710円を精算した。新UNKNOWNは0。
停止ACK、全owned process回収、限定cleanupを確認し、150以後は未送信である。
旧台帳prefixを保持し、原output_textを凍結validatorで無通信再検証した。

全入力19請求項と必須閉路2件の形式coverageは揃ったが、45命題・240引用のうち
13引用が不適合（範囲内occurrence超過8、範囲外の語4、合成引用1）だった。
別モード内の同名文字列、弁の状態と動作対象、行為順序の意味にも不良が残った。
固定20欄24文14参照の対象診断は未実行で、品質合格とは扱わない。

修正は既存の抽出指示と架空例だけに限定する。全役割を含むbasisを先に選び、
その部分文字列から完全引用してoccurrenceを再計数する手順と、
既存decoderで検証済みの範囲縮小例と、条件付き動作の役割をpromptへ載せる。
control/bypass/via、同じroute内の入口出口、通電条件と対象弁の役割も明記する。
原文・回答schema・validator・固定対象・low・時間・出力上限は変更せず、
原回答の補修、判定の緩和、新しい汎用基盤は追加しない。

最初の修正では関連111件と実SDK計測が成功した一方、CIの既存長文fixtureで
45件がplan_limitとなった。重複説明と追加JSONを整理し、source指示を
8,431から4,620 bytesへ短縮した。原文・fixture・上限・検証条件は不変更。
その長文fixtureは89,739 bytesで90,000以内に戻った。
該当3系統を含む関連170件と実SDK無通信計測はPASS。入力保守上界は順に
55,581/70,668/55,581/54,828/87,629で、承認済み各90,000以内。
新headのCI・独立レビュー・正規再bind後に限り、同programの第2診断を使う。
第2診断と合格時の正常比較は最大5送信・予約1,066円である。
初回実費を含むLocal将来上界は1,111.71710円、承認1,522円以内。
UNKNOWN2,832円を保持した累計上界はAI6,037.50175円／総7,587.50175円である。
第2診断FAIL等の停止条件と期限は不変。修正後の実AI品質は未証明である。
