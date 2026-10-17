# 指定文献の根拠付き比較（Issue #150）

## 操作と比較範囲

案件の「文献・請求項を選んで根拠付き比較」から、基準請求項と2〜3件の文献、各文献の請求項、文献名・版を指定する。保存原文を表示し、原本の番号・全文末尾・従属参照・画像や数式の欠落がないことを実行者が照合する。対応形式は、行頭の `【請求項1】` を連番で持つ日本語のnative text。請求項内の画像・数式マーカー、欠番、重複、不明な参照・循環、省略、欠損文字は要確認として停止する。PDF/OCRから消失した情報はテキストだけでは検出不能であり、原本照合の申告を機械的な完全性証明と呼ばない。

`draft_patents.parsed_text` と `prior_art_documents.claims_text` を直接採用する。旧 `extractedClaimsJson` の15,000文字入力上限・1,200文字fallbackや2,000文字先行文献入力は新しい比較の正本にしない。番号のないCSV/corpusテキスト等は推測して番号を付けず、原本に対応する資料の再取込みを案内する。全文とは指定請求項と必要な従属参照の全文であり、非選択請求項・明細書全頁・図面・検索網羅性を保証しない。

## 有限な計画と検証

既存managedの参照閉包、比較計画、全組合せ検査、引用一意性・原文一致・UTF-16位置の検証をadapterから再利用する。明示した文献をAI screeningで落とさない。比較専用の同期API metadataは240秒、比較と保存前査読は単一の全体210秒、個別最大180秒とする。後続の呼出しも全体期限の残時間に制限され、各回180秒を保証するものではない。最大3回、retry 0。出力は生成8,192 tokens、既知Azure GPT-5.4の査読32,768 tokensとする。新規生成は最大4組・2組/回・最大2回とし、残る1回で全4組までを査読する。査読は比較結果の再生成ではない。異なる候補文献の組を文献ID付きで束ねるため、3文献各1組にも対応する。旧6組の保存結果は引き続き読めるが、新規の5〜6組は範囲を絞る必要がある。

時間枠は共有budget内の閉じた比較専用capabilityで適用し、通常処理とmanaged watchの35秒は変更しない。既存budgetとの入れ子、上限の上書き、scope終了後の新しい送信を拒否し、終了時には進行中の比較通信も中断する。比較の全体期限をtransportと生成/査読で共有する。費用・回数・入力/出力・usage照合・失敗後停止の条件は緩めない。新しい時間枠で実AIを行うには、そのheadと時間/回数/費用/期限に一致するOWNER承認が必要。

[Azure Container AppsのHTTP ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress?tabs=bash)は240秒のrequest timeoutを持つ。[Next.jsのmaxDuration](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#maxduration)は配備platform向けmetadataであり、それだけで実ホストの時間制限を変えるものではない。AI全体210秒はDB予約後に始まるため、予約・保存等を含む実際のHTTP所要時間と240秒内の完了を実アプリ受入で確認する。Azure設定は変更しない。35秒停止の観測だけから、180秒で完了することや意味品質の改善を保証しない。

入力はsystem・schema・二重JSON escapeと余白を含めて90,000 bytes以内か事前検査する。全原文と最大長の生成欄を含む査読要求も、DB予約・最初の送信より前に検査する。生成後は実際の査読要求も再検査する。完全な計画が収まらなければ最初の送信前に停止し、対象を絞るよう案内する。managed watchの41回枠・本番承認は継承しない。

すべての予定組合せを一度ずつ検証してから保存する。共通点・差分候補・未確認を分離し、両側の原文根拠を付ける。不存在や法的結論、risk段階を成功結果として提示しない。文字列一致は説明の意味の正しさを保証しないため、人による照合状態は `human_review_required` のまま。

生成指示は必須条件と択一・組合せ・全部の範囲を対象ごとに保持し、別の対象の条件を一列にまとめない。片側の選択肢としての対応は共通点にも明示する。独立した意味照合では、各説明について主語/対象、必須・択一、否定/条件、従属先の関係を原文と突き合わせる。短い代表引用と全文付録の双方を確認し、原文一致だけでは合格にしない。誤った意味の結果は原本/帳票を上書き訂正して実AI合格へ昇格させず、元の試行と指摘を保持する。修正後の再実証も送信数・費用・期間の残枠が必要。

新規生成では全文を最大120 UTF-16単位の連続区間へ欠落なく分け、モデルには根拠IDを選ばせる。区間の連結は原文そのものであり、論理条件の分割や要約ではない。改行・空白・末尾も保持し、サロゲート対を分断しない。文献/版/側/請求項/開始位置に固定したIDからサーバーが引用を復元し、既存managed検証でpairごとの参照範囲・一意性・位置を再確認する。同じ引用が複数存在する区間は全文に残すが選択不可とし、根拠を選べない対象は送信前に要確認とする。加工引用や省略記号の補完はしない。

入力の各組合せには指定請求項と推移的な従属参照の番号一覧を両側別に持たせる。同じ1回の生成内で参照範囲の全文に基づく各側の短い観察、共通点/差分、最後に代表根拠IDの順に出力させる。子請求項へ再掲されていない条件も従属先から読み取り、代表引用の範囲へ比較を狭めない。択一の参照先を同時必須にする指示ではない。引用位置が曖昧な区間も比較本文から除外せず、引用可否を本文不足の理由にしない。新規生成で内部属性名が説明へ混入した場合は保存前に拒否するが、この追加条件で旧保存結果を閲覧不能にしない。

生成と査読には比較専用の参照guideも渡す。原文の正確な参照句とUTF-16位置、直接参照の辺、明示されたany_of/all_of/singleを保持する。全参照先は読む範囲であり、同時継承の一覧ではない。全枝共通の請求項番号をguaranteedClaimNos、枝に依存する番号をconditionalClaimNosとして示すが、番号の共通性と技術条件の共通性は別で、集合外の記載条件を任意にしない。原文を最優先に再確認する。混合・省略・未解決の参照を推定で埋めず、送信前に要確認として停止する。共有parserは変更せず、原文全文をguideへ重複転記しない。wireには参照の辺と選択scopeの番号集合を各sourceにつき一度だけ渡し、空の診断・重複identity/閉包を省いて既存90,000bytes枠を維持する。原文や比較欄は削らない。

生成provider schemaも実際の側別IDを選択肢に固定し、enumの件数・文字数制限は入力bytesとは別に送信前検査する。観察は生成時の補助情報で、意味の正しさを機械検証した証明ではない。保存v1・画面・PDF/CSVの形式は維持し、過去結果に新しいIDや観察を要求しない。IDが正しくても主語の取り違えや従属先の条件を踏まえない差分説明は起こり得るため、実AI受入では観察と全説明を原文へ独立照合する。

生成後、別のAI呼出しに無省略の原文・各組の参照範囲・全生成欄・代表引用を渡して査読する。各組の両側観察/common/differences/unconfirmedの全5欄をサーバーが対象化し、原文・生成欄digestと対象ID集合を固定する。全欄の判定がconsistentで、対象欠落/重複/追加や当該組の範囲外参照がない場合だけ元の比較結果を保存する。不一致・未確定・出力不足・usage不明・期限超過は全体失敗とし、修正文の採用・自動再生成・4回目の送信はしない。欄内の全節を意味的に確認したことを機械証明するものではなく、同じモデルの誤判断が相関する限界もある。保存結果のhuman_review_requiredは維持し、旧保存結果へ新査読済みの表示を付けない。

査読の入力は指定請求項ごとの全原文参照範囲・版・参照分岐guide・組合せ・全生成欄を保持する。原文はgenerationの可逆分割を共有し、IDと本文のtupleで空白・反復を含む全片を渡す。代表引用はclaim/start/endを同じ原文へ結び付け、重複quote本文だけを省く。全sourceと全scopeの条件の意味を確認し、引用された抜粋だけへ評価を狭めない。

各欄を句点単位へ可逆分割し、全文と各unitの開始位置を入力する。回答は各unitのevidenceIds・sourceComparison・verdict・rejectedTargetAnchorに集中する。AIが再作成するglobal facts/status、草稿の再要約/分類、欄単位の理由/番号/集約判定はraw契約から除く。これらを含む旧wireはstrict拒否し、自動移行・字段削除・旧回答の再分類はしない。対比文の旧80文字上限を撤廃し、総token/応答bytes境界で停止する。切断した説明を補完して合格にしない。

全target/unitを一度ずつ照合し、欠落・重複・追加・境界改変・空の対比文・制御文字を拒否する。根拠IDは実際のcatalogに照合し、当該側・文献・参照閉包内の空白でないsegmentだけを許す。baseObservationは基準側のみ、candidateObservationは当該候補側のみ。確定した各unitには最低1根拠、common/differences/unconfirmedの欄全体には両側根拠を求める。片側ずつ述べる文に無関係な反対側根拠を要求しない。未知・重複・別文献・閉包外根拠はuncertainでも拒否する。uncertainは不足根拠を空配列で示せるため、Uを含む欄の両側根拠は未確定を許すが、保存不可。請求項番号は実際の根拠から導出し、選択番号で穴埋めしたり3件へ切り捨てたりしない。

inconsistentの各unitは、そのunit内に一意に完全一致する最大120 UTF16単位の問題引用文字列を返す。空白・不存在・反復による曖昧さ・隣文・サロゲート対途中・正規化差を拒否し、Localで位置を導出する。consistent/uncertainではnull。欄の集約はI＞U＞C、最初のnegativeは回答配列順でなく原文開始位置で決める。inspectReviewCoverageは構造検査のみで、validateReviewは形式が正しいnegative/uncertainも拒否する。派生レポートをrawへ再投入せず、元の回答を検証する。全unitがconsistentのときだけ元の草稿を保存し、保存v1は変更しない。

必要scope・参照枝・条件や断定の解釈を解決できなければ、それを必要とするunitをuncertainにする。番号範囲/スラッシュ/「まで」/継承から全項ANDを補わない。択一枝に共通する技術条件の上位要約と、選択群・必須部分・発動条件を変える省略を区別する。主体・修飾・経路/順序/位置・否定・全member・閾値・終了/例外条件を保持する。隣文の正しさで誤りを救済せず、関連語や引用の存在だけで合格にしない。構造検査は対比文の真偽を保証せず、全原文条件・全説明のrootと独立レビューによる意味QAが必要である。

選択集合を全体として定義する断定は、原文の許容集合全体と比較する。列挙を狭めた定義を部分例示へ読み替えず、「のみ」の有無だけで限定を捨てない。「含む/一例/少なくとも一部」等も自動合格の合図にせず、文全体の集合・修飾範囲を読む。unconfirmedも留保命題自体を査読し、原文が同一性不明を支持するならconsistentとする。対象構成の不明と、留保の妥当性を判断できないことを区別する。査読の対比説明自身の全称・否定・限定も全原文へ照合し、根拠IDは必要な文節と結論までを示す。正しく誤りを指摘しても、理由に別の排除・一般化・根拠欠落があれば意味品質不合格である。

既知Azure GPT-5.4の比較だけ、生成low/8192、probeと保存前査読medium/32768を明示引数で分ける。対象は通常名・日付版・既存normal alias `patentai-gpt54` の完全一致で、aliasにはSDKのforceReasoningも指定する。ARMで実モデルを確認し、実SDKの段階別要求も送信前検査する。未知aliasやminiへ推測適用しない。OpenAIの既存low/8192、Googleのminimal/8192を維持する。共有transportの大出力例外はprivate comparison capability・normal・medium・既知Azure modelだけ。low/high/指定欠落や通常/managed/fast等の8192既定を変えない。モデル・Azure設定は変更しない。

新形式のprobe20はHTTP200/約165秒で全24文が完結したが、既知3誤り中1件の選択集合縮小を見逃し、査読理由の誤一般化・根拠不足・留保への過剰Uも残って意味品質不合格だった。AND補完による誤拒否の解消や構造PASSをTECHNICAL_GOにしない。Local補助工具が、正しい経路根拠の祖先番号1/2を認めず選択番号3を強制した過剰制約も別件として記録する。修正は次の新namespaceだけに適用し、旧応答・旧工具・旧不合格は保全する。新head・全検証/独立レビュー/CI・新operatorのstage別guard・全hash・費用/保持予約・具体的公開記録のreadback後に、新しい応答で実証する。

入力framing8192bytes込み90000bytes、各入力150000tokens、応答1MiB、各180秒/単一全体210秒/API240秒、通常最大3送信・retry0を維持する。usage不明/上限超過/timeout/不完全応答は後続送信・保存停止。継続承認はIssue本文の有限期限・累計回数・AI3000円/総5000円内だけで適用し、旧unknown予約を解放しない。probe/査読328円、生成206円のstage別予約を検査する。架空テストや小さいschemaだけを実AI意味品質合格とは呼ばない。

## 保存・整合・旧結果

schema/migration変更なし。実在する基準請求項と先行文献の行に、既存 `matched_elements_json` のversion付き `priorArtComparison` envelopeを追記する。旧reader用キーは維持し、旧結果へ新しい全文検証済みの意味を付けない。案件画面は新形式を旧スコア一覧へ混ぜず専用の保存結果へ案内する。

保存結果の読取りは原文・参照・組合せ・位置・digest・構造上限を再検証するが、後日変更された生成指示の送信バイト予算は適用しない。指示の拡充で過去の完全なsnapshotを閲覧不能にせず、新規送信は常に現行指示を含む全量で予算検査する。

保存snapshotには生成時点、原文/文献/版、対象範囲、引用位置、完全性の申告、未確認、operationId、canonical digestを保持する。全計画の検査後、比較専用transaction advisory lockと既存案件lockの下で、実IDの全結果行に`reserved`をcommitする。予約commitの応答確認前にはAIを送らない。AI後に既存案件lockとsource row lockを取得し、入力revision・予約operation/selection・行集合を再照合して、自分の予約だけをatomicに`complete`へ更新する。入力変更・不完全応答なら完了保存しない。以前の正常結果を削除しない。

未確定予約は再起動後も残り、同operationIdだけでなく同案件の新operationIdも送信を拒否する。時刻による自動失効や予算リセットはしない。成功COMMIT応答不明は同じoperationを読み戻すだけで、AIを再送しない。未確定結果は成果や正常0件として扱わず、別表示する。browserのpending operationもsessionStorageに保持する。未確定予約の解除APIは本範囲に含めず、実行者の利用状況・保存状態の照合と適用可能な再実行承認が必要になる。既存結果の再取得は引き続き可能。

文献の更新に伴う旧比較の無効化はlegacyだけに適用し、新snapshotは当時の由来を保持する。文献の明示削除ではversioned行のnullable FKを切り離し、実際に参照していたdocIdをJSONに保持して保存成果を残す。現在入力と異なる結果は明示する。案件全体の明示削除は既存契約のまま。未知version・不完全/競合groupは成功扱いせず、整合しない結果の帳票化を拒否する。

## 取得資料

PDFとCSVは保存snapshotのみから生成し、再取得もAI送信0。既存PDFKitの有限rendererとCSV数式注入対策を再利用する。テーマ、文献/版、指定請求項、生成時点、共通点、差分、根拠位置、未確認/限界と、採用した請求項・参照先の全文付録を含む。レイアウト都合の本文切捨てはしない。PDFのglyph/ページ上限等は明示的に失敗し、CSVまたは入力範囲の確認を案内する。

すべてのpage/APIは既存owner認証・CSRF・案件所属・no-storeを維持する。エラーは固定文言で、SDK/DBの生例外、資格情報、認証済みURLを公開しない。

## 実行と受入判定

査読は各欄の全文を句点単位へ可逆分割し、開始位置だけを補助情報として渡す。各文について草稿の実際の断定と、同じ対象の原文条件の対比を必須にする。文の欠落・重複・範囲外・空の照合、判定をサーバー側で集約し、不整合箇所は不整合と判定した文の中に限定する。正しい後半だけで欄全体を合格にしない。番号範囲から全条件の同時継承を推定しない。これらは確認範囲と集約の検査であり、対比文や意味判定の正しさは独立原文照合が必要。全文・保存v1・回数/時間/byte/token上限は維持する。

- 通常の架空テスト: `pnpm test`、`pnpm lint`、`pnpm type-check`、`pnpm build`。
- 専用実アプリ受入: build後、`PRIOR_ART_COMPARISON_ACCEPTANCE=1` と `PRIOR_ART_COMPARISON_DB_TEST=1` を明示し、既存Playwright packageを `PRIOR_ART_PLAYWRIGHT_MODULE` へ指定して `pnpm test scripts/prior-art-comparison-acceptance.test.ts --maxWorkers=1`。`DATABASE_URL`等が親にあれば空PG作成前に拒否する。専用PG16へ既存migrationだけを適用し、loopback・専用Chrome profile・架空principal/AI/Blob transportを使用する。実Azure認証/Storageの受入ではない。TXT multipart→実parser→架空Blob transport/実DB→原文選択まで照合する。各テストの資源だけをlabel照合して回収する。
- 原文末尾/依存参照、保存/再表示/サーバー再起動、全PDFページ/CSV全行、誤引用・欠落、auth/CSRF、失敗時保全を確認し、fixtureの実アプリ一巡だけを `LOCAL_INTEGRATION_PASS` と呼ぶ。
- `PRIOR_ART_COMPARISON_TECHNICAL_GO` は、同headの許可済み実AIで公開資料2〜3件を比較し、原本と全引用・全組合せ・説明全件を独立照合し、必須CI/レビューも通過してから。専門家評価は別の `EXPERT_ACCEPTANCE_PENDING`。

## 承認・統合・rollback

実AIの適用可能な対象/用途/期間/回数/費用/回収まで一致する承認を確認できるまでは実送信しない。#148や過去Issueの一回枠・予約・unknown usageを流用しない。Local実装/帳票/レビュー/PRは先に完成させ、不足があれば一度の具体的な最小承認案にまとめる。

Draft PRと`codex:no-auto-merge`はTECHNICAL_GO、現headのCI/独立レビュー、#148の所有/統合順と固定imageへの非影響、App/Manual Job配備の費用/回数/codeSha/署名/停止/rollback条件がすべて成立するまで維持する。Production実受入は別判定。rollbackは本差分のrevert PRと承認済み通常deployで、旧部分比較の品質制限を明示する。元worktree、既存原本/DB/試用資材のreset・削除をrollbackと呼ばない。

Issue150の通常統合は既存`managed-budget-admin`の署名済み`release-start`を使用する。`issue150Integration`は本Issueだけに存在し、通常のactive standard profileへ束縛する。129/140の既存形式・digest・完了例外は変更しない。期限は継続承認の2026-10-18 15:41:40 JST、配備1回・rollback1回。各配備40分（計80分）、revert準備のCIは各20分を既存IO余裕とともに開始時の期限へ含める。署名preflightには同headのTECHNICAL_GO、統合tree、baseline tree、全AI既知費用とunknown保持額を切上げたexposure、全triggerを含む税込予約とrollback留保を記録する。AI3000円・追加統合2000円・統合開始見通し1600円・総5000円を超えない。留保は将来の開始許可ではなく、各開始で通常profileの費用と全9unit、当月pricing、pool、期限を再検査する。140の拡張が同月にあっても通常上限を借用しない。

保持されたadmin sequenceから原本署名・digest・連鎖を読み戻し、150の全承認digestを横断して消費を集計する。各150 stepのrequest/intent/start claimとpreflight原本を再照合し、unknown/ACK不明や精算0から配備回数を復活させない。過去activateの署名を現在のGO pinへ再束縛せず、新規activateの既存GO検査は維持する。最後にstateを再読取し、reserve/claim/admin sequenceを既存の単一CASへ保存する。新規ACKの`admitted`だけが最大60秒以内の指定操作を許可し、readback/reconcileから再実行権を作らない。

rollbackは、署名したforward結果原本が実merged PRのhead/base/merge/tree/parentとterminal配備metadataへ一致することをLocalで照合してから行う。署名者による外部事実の照合が信頼境界であり、hashだけで実配備成功を証明しない。失敗した配備はrevertできるが、結果不明の配備と重ねない。専用`codex/issue-150-revert-` branchの初回push、PR作成、通常squashを各一度だけ予約し、head/base/treeとforward operationを拘束する。revert treeは元baseline、baseは実forward merge SHAに一致させる。別変更でmainが進んだ場合、この最小経路で全treeを戻さず停止する。新infra/state schema/資格情報/設定は追加しない。

比較結果の確定・文献削除時の切離しは同一transaction内のDELETE RETURNINGと同一実resultIdのINSERTで行い、既存のSELECT/INSERT/DELETE権限だけを使用する。比較tableのUPDATE権限やsequence再設定を追加しない。専用DBの非管理者roleからcomparison_resultsのUPDATEをrevokeして検証する。通常配備前の既存権限確認は別で行い、watch/import用LOGINを流用・拡張しない。
