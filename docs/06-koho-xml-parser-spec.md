# 公報XMLパーサー仕様

本書は、JPA／JPB週次公報ZIPからprimary公報XMLを識別し、特許文献の
書誌・本文フィールドを安全に構造化抽出するための仕様である。2026-155号
の全件調査で確認した事実を基礎とし、観察事実と実装時の取込契約を区別して
記載する。

本仕様が扱うのはデータ取り込みであり、新規性、進歩性、権利範囲、異議申立
期限その他の法的判断ではない。抽出結果は調査、比較、論点整理の支援にのみ
用い、未知ケースは技術状態として人間の確認へ回す。

## 1. 目的・適用範囲

### 1.1 目的

- ZIPを全展開せず、entry単位で公報を読み取る。
- A1、A5、P1、P5、B1、B2を区別する。
- primary公報XMLとnested ST.26配列表XML、画像、その他添付を分離する。
- 公開番号、登録番号、出願情報、出願人、分類、要約、請求の範囲、明細書を
  構造を失わず抽出する。
- 未知の版、root、namespace、kind、欠損、索引不一致を黙って正常扱い
  しない。

### 1.2 対象

- JPAの公開特許公報系A1、補正掲載A5、公表特許公報系P1、補正掲載P5
- JPBの特許公報B1、B2
- ZIP直下と文献区分内の索引CSV
- primary XMLから参照されるnested ST.26 XML、画像、表、数式、化学式等の
  参照情報

### 1.3 対象外

- 公報ZIPの取得、自動download、J-PlatPatの自動操作
- TIF/JPG/PDF本文のOCRまたは画像内容解析
- ST.26配列表の配列内容解析
- A5/P5の補正内容を元公報へ自動統合する処理
- DB、API、UI、scheduler、通知、法的期限計算
- 公報の記載から法的結論を生成する処理

本書の観察値は2026-155号に限られる。他号、過去版、将来版、今回含まれ
なかった公報種別との互換性は、実装Issueで公開可能なfixtureとLocal回帰
検証を用いて別途確認する。

## 2. 入力コンテナと安全要件

### 2.1 ZIPの読取

1. ZIP中央directoryを読み、entry一覧を作る。
2. entry名を`/`区切りへ正規化してから安全性を検査する。
3. 必要なXML、CSV、schema参照、添付参照だけをstreamで読む。
4. ZIP全体をfilesystemへ展開しない。
5. entryごとに原path、正規化path、非圧縮size、処理結果を記録する。

処理開始前に、実行環境ごとに0より大きいpackage全体のresource上限を設定する。
少なくともZIP sourceの総byte数、中央directoryのbyte数、entry数、累積圧縮
payload byte数、累積非圧縮byte数、およびentry単位の圧縮／非圧縮byte数を個別に
制限する。中央directoryとentry headerの申告値は事前拒否に使うだけで信用せず、
中央directoryのparse中、ZIP sourceの受信中、および各entryのstream読取中に実際の
entry数とbyte数をoverflow-safeなcounterで加算する。申告値または実測値のどちらかが
上限を超えた時点で、それ以上の割当て、読取、展開を停止し、packageを`取込失敗`と
する。選択対象entryの合計が上限内でも、ZIP全体のentry数または中央directoryが上限を
超えるpackageは受け入れない。

次のentry名は拒否し、`取込失敗`とする。

- 絶対path、drive letter、UNC path
- `..` segment、NUL、正規化後にcontainer外を指すpath
- 正規化すると同じpathになる重複entry
- basenameまたは親directoryとの照合を曖昧にする不正な区切り

### 2.2 XMLの安全要件

- primary XMLではDTD読込、外部実体、外部schema、外部network解決を
  無効にする。
- namespace-aware XML parserを使い、prefixの文字列ではなくURIで照合する。
- XMLの内部展開量、再帰深度、entry sizeには実行環境の上限を設定する。
- nested ST.26を検証する場合もnetwork解決は禁止する。DTDが必要なときだけ、
  ZIP内の既知DTD basenameをlocal catalogでallowlist解決する。
- root、namespace、schema参照が矛盾するXMLはprimaryとして確定しない。

### 2.3 entry種別

| entry | 扱い |
|---|---|
| primary公報XML | 第6章の複合判定を通過したものだけ構造化抽出する |
| nested ST.26 XML | 添付参照として別count・別状態で保持し、公報countへ加えない |
| legacy ST.25 `.app` | 添付参照として保持し、primary XML parserへ渡さない |
| TIF/JPG/PDF | 本文XMLにしない。安全な相対参照とmedia種別だけを保持する |
| CSV | 第4章の論理file別grammarで解析する |
| DTD/XSD/XSL/JS | schema/version照合のmetadata。実行可能codeとして実行しない |

TIFを本文XMLとして扱ったり、画像から黙って本文を補完したりしてはならない。

## 3. ディレクトリ・文献区分

### 3.1 primary文献区分

| package | directory | 正式名称 | `DOCUMENT_LIST` kind | primary root | 用途とprimary条件 |
|---|---|---|---|---|---|
| JPA | `P_A1` | 公開特許公報（特開） | `A` | `jppat:UnexaminedPatentPublication` | full publication。path、root、公開番号が一致すること |
| JPA | `P_A5` | 補正の掲載（公開特許公報） | `A5` | `jppat:UnexaminedPatentPublicationAmendment` | 補正掲載event。元公報全文として扱わない |
| JPA | `P_P1` | 公表特許公報（特表） | `A` | `jppat:InternationalPatentPublication` | full publication。XMLの国内側公開番号をpath／indexと照合し、`A`だけでA1と区別しない |
| JPA | `P_P5` | 国際公開後における補正の掲載 | `A5` | `jppat:InternationalPatentPublicationAmendment` | 補正掲載event。event国際公開番号とpath／indexの国内側package keyを分離し、`A5`だけでA5と区別しない |
| JPB | `P_B1` | 特許公報 | `B1` / `B2` | `jppat:RegisteredPatentPublication` | full publication。B1/B2はCSV kindとXML表示を照合する |

A5/P5は訂正公報の別名ではない。`WrittenAmendmentBag`を持つ補正掲載event
として保存し、既存のA1/P1 recordを上書きしない。

P5のXML `PublicationNumber`はevent自身の国際公開番号であり、entry folderや
`DOCUMENT_LIST`の番号へ直接照合しない。P5のpackage identityは正規化した
entry pathの`document-no`と`DOCUMENT_LIST`の国内側番号・kindから確認する。

### 3.2 path形状

2026-155号のprimary XMLは次の形であった。

```text
DOCUMENT/<section>/<100件bucket>/<10件bucket>/<document-no>/<document-no>.xml
```

正規化後のpath depthがこの形に一致し、XML basenameと親document folder名が
一致することをpath側のprimary候補条件とする。明示的なdirectory entryは
存在しない場合があるため、文献directory数はfile pathのprefixから復元する。

より深い`<document-no>000001/*.xml`、`AMEN00001/*.xml`等は添付候補であり、
primary件数から除外する。directory名だけではprimaryを確定せず、第6章の
root、namespace、kind、番号、schema照合を続ける。

### 3.3 nested ST.26

- rootは`ST26SequenceListing`。
- 観察されたDOCTYPEは`-//WIPO//DTD Sequence Listing 1.3//EN`、
  `dtdVersion`は`V1_3`である。
- primary XMLの`ReferenceFilesBag`から参照される添付であり、公報ではない。
- deeper path、root、参照元を併用して判定し、拡張子`.xml`だけで公報扱い
  しない。

## 4. CSV索引仕様

### 4.1 共通grammar

2026-155号で観察したCSVは、BOMなしUTF-8、comma区切り、headerなし、CRLF、
終端CRLFありであった。quote使用例はなかったが、これをquote禁止とは解釈
せず、実装はCSVのquote/escapeを扱えるparserを使う。

全fileで次を守る。

- 不正UTF-8、列数・反復count・文字長の矛盾は正常recordにしない。
- source recordとsource cellを保持し、意味変換後も監査可能にする。
- CSV全cellへの一律`trim()`を行わない。区分labelのpaddingや
  `CONTENTS2`の予約spaceをsource cellで保持し、照合用viewだけfield別に正規化する。
- 日付と番号を数値へ変換して先頭zeroを失わない。
- publication numberの重複、同じ番号に対するkind/date矛盾は
  `確認候補`とし、自動deduplicateしない。
- 空欄、列省略、ASCII single-spaceを区別してparseする。

| 論理file | 配置 | 役割 | primary XMLとの照合 |
|---|---|---|---|
| `ABSTRACT.csv` | ZIP root | package metadataと区分別集計 | 集計値をdirectory/root別primary件数と照合する |
| `DOCUMENT_LIST.csv` | ZIP root | 1文献1recordの文献一覧 | normalized package番号、kind、発行日を照合する。P5ではevent番号でなくentry pathの国内側番号を使う |
| `CONTENTS1.csv` | `DOCUMENT/<full-publication-section>/` | 反復を保持する詳細索引 | publication numberでXMLへ対応付け、複数分類・出願人を照合する |
| `CONTENTS2.csv` | `DOCUMENT/<full-publication-section>/` | 固定列の縮約索引 | 先頭分類・先頭出願人だけを照合に使い、完全情報源にしない |

A5/P5には`CONTENTS1.csv`と`CONTENTS2.csv`が観察されていない。

### 4.2 `ABSTRACT.csv`

heterogeneous recordであり、先頭recordと集計recordを同じschemaで扱わない。

公開仕様の根拠は、特許庁「公報仕様 第1.5版 第II編 各ファイルの詳細」
pp.48-49の抄録file format、および「公報仕様 第1.6版 第I編 全体構成」
p.25の公報種別とdirectory名の対応である。

- https://www.jpo.go.jp/system/laws/koho/shiyo/document/koujigou_vol15/1-2_file_kousei.pdf
- https://www.jpo.go.jp/system/laws/koho/shiyo/document/koujigou_vol16/1-1_zentai_kousei.pdf

先頭record:

| position | 論理名 | 型 | 空欄 | 規則 |
|---:|---|---|---|---|
| 1 | `packageCode` | string | 不可 | public API互換名。公式の意味は公報仕様version codeで、`A_`または`B_`の発行区分prefixとASCII 3桁versionからなる。source valueを保持し、JPAは`A_`、JPBは`B_`だけをfamily一致として解決する。既存の`JPA`/`JPB`入力も互換値として維持する |
| 2 | `publicationDate` | `YYYYMMDD` string | 不可 | package発行日。XMLの出願日・登録日と混同しない |
| 3 | `issueNumber` | string | 不可 | 号識別子。文献番号として使わない |
| 4 | `issueControlValue` | opaque string | 不可 | 観察値`01122`の意味は未確定 |

JPAの後続集計record:

| position | 論理名 | 型 | 空欄 | 規則 |
|---:|---|---|---|---|
| 1 | `sectionName` | string | 不可 | 公式形式は`公報種別名(directory code)`を「全角40文字固定」とし、不足分を末尾ASCII spaceで埋める。sourceを保持し、照合用viewだけpaddingを除いてlabelとcodeの対応を検証する |
| 2 | `publicationNumberRange` | string | 不可 | 名目範囲。実件数そのものではない |
| 3 | `documentCountText` | 5桁zero埋めdecimal string | 不可 | integer派生値とsource valueを保持 |

JPBの後続集計record:

| position | 論理名 | 型 | 空欄 | 規則 |
|---:|---|---|---|---|
| 1 | `sectionName` | string | 不可 | 公式形式は`公報種別名(P_B1)`を「全角40文字固定」とし、不足分を末尾ASCII spaceで埋める。label/code矛盾やpadding過不足は確認候補 |
| 2 | `publicationNumberRange` | string | 不可 | 名目範囲 |
| 3 | `documentCountText` | 5桁zero埋めdecimal string | 不可 | primary実件数との照合値 |
| 4 | `missingNumbersInRange` | semicolon区切りstring list | 可 | 範囲内欠番。空なら空list |
| 5 | `includedNumbersOutsideRange` | semicolon区切りstring list | 可 | 範囲外収録。空なら空list |

公式labelとcanonical sectionの対応:

| 公報種別 | canonical section |
|---|---|
| 公開特許公報 | `P_A1` |
| 補正の掲載(公開特許公報) | `P_A5` |
| 公表特許公報 | `P_P1` |
| 国際公開後における補正の掲載 | `P_P5` |
| 特許公報 | `P_B1` |

末尾ASCII space以外の文字を一律trim/NFKCしない。括弧は公式どおりASCII、
directory codeは既知canonical値とのexact一致とする。「全角40文字固定」は、
JIS X 0208文字を2単位、JIS X 0201文字を1単位とする80単位の固定幅として検証する。
UTF-8 byte長では判定しない。labelとcodeが矛盾する値、padding過不足、未知code、package
familyと矛盾する仕様version codeは成功扱いしない。同じcanonical sectionが互換
labelと公式formatの両方で現れた場合もduplicateとして確認候補にする。

`01122`は文献識別、件数判定、kind分岐、日付変換に使用しない。source valueの
`issueControlValue`としてのみ保持し、意味が確定するまでopaqueとする。

### 4.3 `DOCUMENT_LIST.csv`

4列固定で、headerはない。

| position | 論理名 | 型 | 空欄 | 規則 |
|---:|---|---|---|---|
| 1 | `countryCode` | string | 不可 | 観察packageの国code。未知値は確認候補 |
| 2 | `publicationNumber` | string | 不可 | leading zeroを保持するpackage照合番号。P5ではXML event番号へ直接照合せず、entry pathの国内側番号へ照合 |
| 3 | `kindCode` | string | 不可 | `A`、`A5`、`B1`、`B2`。A/P区別にはroot/pathも必要 |
| 4 | `issuePublicationDate` | `YYYYMMDD` string | 不可 | 当該recordを収録した公報発行日 |

A5/P5の`issuePublicationDate`を元のA1/P1公報発行日と解釈しない。
同一publication numberの重複record、対応するpackage key不在、kind矛盾、
日付矛盾は`確認候補`とする。P5は同一内容の重複recordでも単一候補とみなさず、
identityを確定しない。

### 4.4 `CONTENTS1.csv`

可変長・反復型で、次の順に読む。JPBだけ`registrationDate`が
`formattedPublicationNumber`直後に入る。

| 順序 | 論理field | 型・cardinality | 空欄・省略 |
|---:|---|---|---|
| 1 | `recordCharacterLength` | decimal、1 | 不可。CRLFを除くUnicode文字数 + 論理改行1と照合 |
| 2 | `divisionSectionCode` | string、1 | 不可 |
| 3 | `formattedPublicationNumber` | string、1 | 不可 |
| 4（JPBのみ） | `registrationDate` | date string、1 | 不可 |
| 次 | `formattedApplicationNumber` | string、1 | 不可 |
| 次 | `displayFlagCount` | decimal、1 | 不可 |
| 反復 | `displayFlag` | string、0..N | count=0なら列自体を省略 |
| 次 | `displayClassificationCount` | decimal、1 | 不可 |
| 反復 | `displayClassification` | string、0..N | count=0なら列自体を省略 |
| 次 | `titleCharacterLength` | decimal、1 | 直後のtitle文字数と照合 |
| 次 | `title` | string、1 | 長さ0を許すかは未知ケースとして確認 |
| 次 | `applicantCount` | decimal、1 | 不可 |
| 反復 | `locationCharacterLength` | decimal、applicantごとに1 | 直後のlocationと照合 |
| 反復 | `location` | string、applicantごとに1 | source valueの空欄を保持 |
| 反復 | `partyIdentifier` | string、applicantごとに1 | leading zeroを保持 |
| 反復 | `applicantNameCharacterLength` | decimal、applicantごとに1 | 直後のnameと照合 |
| 反復 | `applicantName` | string、applicantごとに1 | source valueの空欄を保持し確認候補化 |

`recordCharacterLength`の「文字」はbyte数ではない。採用言語のcode unitを
無条件に使わず、Unicode文字数としてfixtureで検証する。display flagの
観察値はJPAの`請`、JPBの`早`、`際`であった。これらを閉じたenumにせず、
未知値もsource valueで保存して`確認候補`とする。

### 4.5 `CONTENTS2.csv`

JPAは17列固定:

| position | 論理名 | 型 | 必須・空欄 | 規則 |
|---:|---|---|---|---|
| 1 | `recordLength` | decimal | 必須 | JPAはCRLFを除くUnicode文字数 + 論理改行1と照合。byte長ではない。JPBの厳密な計算規則は未確認 |
| 2 | `divisionSectionCode` | string | 必須 | source valueと照合用viewを保持 |
| 3 | `publicationNumber` | string | 必須 | leading zeroを保持 |
| 4 | `applicationNumber` | string | 必須 | leading zero、prefix、表示区切りを保持 |
| 5 | `displayFlagCount` | decimal | 必須 | `0..7`。slotのsemantic値数と照合 |
| 6..12 | `displaySlot1` .. `displaySlot7` | string | 7列必須 | 未使用slotのsource valueはASCII single-space |
| 13 | `firstClassification` | string | 1列必須、semantic値は`0..1` | `CONTENTS1`の先頭分類だけ |
| 14 | `title` | string | 1列必須 | source cellを保持 |
| 15 | `firstApplicantLocation` | string | 1列必須、semantic値は`0..1` | `CONTENTS1`の先頭Applicantだけ |
| 16 | `firstPartyIdentifier` | string | 1列必須、semantic値は`0..1` | 数値化しない |
| 17 | `firstApplicantName` | string | 1列必須、semantic値は`0..1` | source cellを保持 |

JPBは`registrationDate`をposition 4へ追加した18列固定で、以後のpositionを
1つずつ後ろへずらす。`registrationDate`はdate stringの必須fieldである。
未使用display slotは空stringではなくASCII single-spaceであるため、
source cellでは`" "`を保持し、semantic viewでのみ`null`へ変換する。

2026-155号の代表JPA `CONTENTS2`は810 recordすべてで、Unicode文字数 +
論理改行1と`recordLength`が一致した。この代表CSV観察をJPAの取込契約とする。
JPBではfieldの存在と18列構造までを確定事項とし、厳密な計算規則は未確認で
ある。JPBの値はdecimalとして保持し、候補式との比較結果を記録しても、公開
可能なfixtureで確認するまでは不一致だけを理由にrecordを拒否しない。

`CONTENTS2`は`CONTENTS1`のlossyな縮約投影である。複数分類、複数出願人の
完全情報には使わない。JPAの`recordLength`不一致、不正decimal、固定列数不一致、
`displayFlagCount`とslotの矛盾は当該CSV recordの`取込失敗`とし、
重複recordはpublication number単位で`確認候補`とする。

## 5. XMLスキーマ・namespace・版情報

### 5.1 namespace

XPathのprefixは本書内の記法である。入力XMLのprefix名が異なっても、次の
URIへbindされていればURI基準で処理する。

| prefix | namespace URI |
|---|---|
| `jppat` | `http://www.jpo.go.jp/standards/XMLSchema/ST96/JPPatent` |
| `jpcom` | `http://www.jpo.go.jp/standards/XMLSchema/ST96/JPCommon` |
| `pat` | `http://www.wipo.int/standards/XMLSchema/ST96/Patent` |
| `com` | `http://www.wipo.int/standards/XMLSchema/ST96/Common` |
| `xsi` | `http://www.w3.org/2001/XMLSchema-instance` |

### 5.2 版の区別

| 概念 | 2026-155号の観察値 | 意味 |
|---|---|---|
| package/号 | `2026-155` | 今回の観察対象。schema versionではない |
| JPO公報仕様書の冊子版 | 調査結果だけでは冊子版との対応未確定 | 号、XSD suffix、ST.96版から推測しない |
| 公報primary schema版 | filename suffix `V1_0` | 区分別JPO primary XSDの版 |
| ST.96版 | root `com:st96Version="V3_1"` | WIPO ST.96 common/patent schema版 |
| JPO/IPO版 | root `com:ipoVersion="JP_V1_0"` | JPO拡張schema版 |
| ST.26 DTD版 | `dtdVersion="V1_3"` | nested配列表の版。primary版ではない |

これらを同じ「version」fieldへ上書きしない。

### 5.3 primary rootとschema

primary XMLはUTF-8、BOMなしで、DOCTYPEは観察されなかった。XML宣言の
versionや属性順を含む字面はprimary判定でexact matchしない。rootの
namespace URIは第5.1節の`jppat` URIであり、`com:languageCode="ja"`、
`com:st96Version="V3_1"`、`com:ipoVersion="JP_V1_0"`を持つ。

| 区分 | root | `xsi:schemaLocation`の期待XSD basename | 主要import |
|---|---|---|---|
| A1 | `jppat:UnexaminedPatentPublication` | `JPUnexaminedPatentPublication_V1_0.xsd` | `Common_V3_1.xsd`、`PatentPublication_V3_1.xsd`、`JPCommon_V1_0.xsd` |
| A5 | `jppat:UnexaminedPatentPublicationAmendment` | `JPUnexaminedPatentPublicationAmendment_V1_0.xsd` | 同上 |
| P1 | `jppat:InternationalPatentPublication` | `JPInternationalPatentPublication_V1_0.xsd` | 同上 |
| P5 | `jppat:InternationalPatentPublicationAmendment` | `JPInternationalPatentPublicationAmendment_V1_0.xsd` | 同上 |
| B1/B2 | `jppat:RegisteredPatentPublication` | `JPRegisteredPatentPublication_V1_0.xsd` | 同上 |

`xsi:schemaLocation`はnamespace URIと相対XSD pathのpairである。相対pathの
`../`個数だけに依存せず、安全に正規化したbasename、namespace、rootの組を
照合する。pairのlocation tokenは相対pathだけを許可し、正規化後にZIP内`XSD/`配下の期待
basenameへcontainすることを確認する。絶対URI、scheme付きURL、drive/UNC、
package外へ出る`..`、期待basenameで終わるだけの外部pathは拒否する。
XSDをnetworkから取得してはならない。

2026-155号では全primary XMLのwell-formedness、root、namespace、version、
schemaLocationを確認した。一方、XSD validation engineによる全件妥当性検証
は未実施であり、「XSD validation済み」とは扱わない。

### 5.4 ST.26とDTD

primary XML用parserではDTDを読まない。nested ST.26を別処理する場合だけ、
`ST26SequenceListing_V1_3.dtd`等の既知ZIP内resourceをallowlistしたlocal
catalogで解決する。`sequence-list.dtd`、`mathml2.dtd`、`soextblx.dtd`、
`wipo.ent`を含め、外部URLや未知basenameは拒否する。

## 6. primary公報XML識別仕様

### 6.1 判定順序

次の順に候補を絞り、単一根拠だけでprimaryを確定しない。

1. **ZIP entry path**: 安全な相対pathで、第3章のprimary形状かを判定する。
2. **root elementとnamespace URI**: 区分別rootと`jppat` URIを組で照合する。
3. **directory区分**: `P_A1`等とrootの対応を照合する。
4. **文献番号**: P1はXML identification、parent folder、CSVの国内側番号を
   正規化keyで照合する。P5はXML event番号を独立検証し、parent folderとCSVの
   国内側package keyを別に照合する。
5. **kind code**: `DOCUMENT_LIST`、root、B1/B2表示を照合する。
6. **schema参照と版**: schema basename、ST.96版、IPO版を照合する。

番号の比較keyは責務別formatを検証したうえで作る。P1 full publicationとP5
package keyは国内側10桁decimal、P5 event番号は`WO` + 10桁として独立に検証する。
表示用space/hyphenを除き、B1/B2のfolder名とXML番号を照合するときはnumeric
coreのleading zeroを比較key上だけ正規化する。source番号は必ず残し、保存値の
leading zeroやP5 event番号の`WO` prefixを失わない。

### 6.2 kind確定

- A1とP1は`DOCUMENT_LIST`上いずれも`A`のため、rootとdirectoryで区別する。
- A5とP5は`DOCUMENT_LIST`上いずれも`A5`のため、rootとdirectoryで区別する。
- B1/B2はrootとdirectoryが共通である。
  `RegisteredPatentPublicationBibliographicData/pat:PlainLanguageDesignationText`
  と`DOCUMENT_LIST.kindCode`を照合して確定する。
- kindの根拠が不一致ならrecordを確定せず`確認候補`とする。

### 6.3 nested・添付排除

次のいずれかに該当するXMLはprimary件数へ加えない。

- primary形状より深いpathにあり、basenameと親document folder名が一致しない。
- rootが`ST26SequenceListing`である。
- `ReferenceFilesBag`から添付として参照される。
- `AMEN00001`等の添付directory配下にある。

`ReferenceFileCategory`がsequence listingであることや拡張子`.xml`だけでは
ST.26と断定しない。安全にrootを確認して`ST26SequenceListing`と一致した
場合にST.26へ分類し、それ以外は別の配列表／添付種別として保持する。

未知root、未知namespace、未知kind、root/path/schemaの矛盾は黙って取り込まず、
`未対応種別`または`確認候補`として原entryを隔離する。

## 7. フィールド抽出仕様

### 7.1 XPath記法

full publicationのroot、bibliographic data、party bagを次のように置換する。

| 区分 | `R` | `B` | `PB` |
|---|---|---|---|
| A1 | `/jppat:UnexaminedPatentPublication` | `R/jppat:UnexaminedPatentPublicationBibliographicData` | `jppat:UnexaminedPatentPublicationPartyBag` |
| P1 | `/jppat:InternationalPatentPublication` | `R/jppat:InternationalPatentPublicationBibliographicData` | `jppat:InternationalPatentPublicationPartyBag` |
| B1/B2 | `/jppat:RegisteredPatentPublication` | `R/jppat:RegisteredPatentPublicationBibliographicData` | `jppat:RegisteredPatentPublicationPartyBag` |

各XPathのprefix/URIは第5.1節を正本とする。cardinalityは「XSD上の範囲／
2026-155号の観察／取込後の出力契約」の順に区別する。

### 7.2 full publication共通field

| field | XPath | cardinality・必須性 | 値形式・正規化 | 欠損時と種別差 |
|---|---|---|---|---|
| 公開番号／公報番号 | `B/jppat:PatentPublicationIdentification/pat:PublicationNumber` | leaf XSD `0..1`、観察`1`、出力`1`必須 | string。外側空白だけ除きsource valueを保持。数値化しない。P1は国内側10桁番号 | 欠損は`取込失敗`。folder/CSV不一致はrecord未確定の`確認候補` |
| 登録番号 | B1/B2では上記`pat:PublicationNumber`を登録公報番号としても写像。A1/P1は非該当 | A1/P1出力`0`、B1/B2出力`1`必須 | XMLに独立`RegistrationNumber`があるという観察事実ではなく、B1/B2用normalized outputの取込契約。source valueを同値写像する | B1/B2で欠損は`取込失敗`。A1/P1へは生成しない |
| 出願番号 | `B/jppat:ApplicationIdentification/com:ApplicationNumber/com:ApplicationNumberText` | identification required、leaf XSD`0..1`、観察/出力`1`必須 | string。source value・prefix・leading zeroを保持 | 欠損は`取込失敗`。priority/related document側の番号と混同しない |
| 出願日 | `B/jppat:ApplicationIdentification/pat:FilingDate` | XSD`0..1`、観察/出力`1`必須 | XMLは`YYYY-MM-DD`としてdate parseしsource valueも保持 | 欠損・不正dateは`取込失敗` |
| 公開日／公報発行日 | `B/jppat:PatentPublicationIdentification/com:PublicationDate` | XSD`0..1`、観察/出力`1`必須 | `YYYY-MM-DD`。package/CSV dateとは別field | A1/P1は公開日、B1/B2は登録公報発行日。欠損は`取込失敗` |
| 出願人名称 | `B/PB/jppat:ApplicantsRegisteredPractitionersBag/jppat:ApplicantRegisteredPractitionerBag/jppat:Applicant/jpcom:Contact/com:Name/com:EntityName` | Applicant`1..∞`。各Applicantの名称出力`0..∞`、`取込成功`にはApplicant全体で有効名称`1..∞`が必要 | Applicant単位と`@com:sequenceNumber`順を保持。NFC。外側空白のみ整理 | Applicantなし、または全Applicantで有効名称0件は`取込失敗`。一部contact/名称欠損は`確認候補` |
| 出願人ID | Applicantから`com:PartyIdentifier` | 出力`0..1`/Applicant | stringのsource valueを保持 | 欠損を別Applicant生成で補わない |
| 発明の名称 | `B/pat:InventionTitle` | XSD/観察/出力`1`必須 | mixed text順を保持しNFC。検索派生だけNFKC可 | 欠損は`取込失敗` |
| IPC | `B/jppat:IPCClassification/pat:MainClassification \| B/jppat:IPCClassification/pat:FurtherClassification` | main`0..1`、further`0..∞`、観察main`1`。出力`0..∞` | XML順、main/further role、版・日付metadata、source記号を保持 | 全欠損は`確認候補`。`CONTENTS2`で補完しない |
| FI | `B/jppat:NationalClassification/(jppat:MainNationalClassification\|jppat:FurtherNationalClassification)/pat:PatentClassificationText` | container`0..1`、内部main`1`/further`0..∞`、観察container`1`。出力`0..∞` | XML順、main/further、suffix、空白facet、source valueを保持 | container欠損は`確認候補`。無言で空stringにしない |
| 要約 | `R/pat:Abstract` | XSD/出力`0..1`。観察A1/P1/B1`1`、B2`0` | paragraph/mixed contentを第8章どおり構造化 | B2の欠損は正常`null`。A1/P1/B1の欠損は`確認候補` |
| 請求の範囲 | `R/pat:Claims/pat:Claim`、番号`pat:ClaimNumber` | Claims`1`、Claim`1..∞`、出力`1..∞`必須 | claim単位、番号、XML順、mixed content、参照を保持 | root claims欠損・0件は`取込失敗` |
| 明細書本文 | `R/jppat:Description` | XSD/観察/出力`1`必須 | paragraph単位、`@com:pNumber`、XML順、mixed content、参照を保持 | 欠損は`取込失敗` |

出願人の`jpcom:OriginalLanguageIndicator=true` contactは、同じApplicantの
alternate表記として保持し、別出願人に重複計上しない。出願人、IPC、FIは
原順序を保持し、source配列をdeduplicateしない。検索用派生keyで重複候補を
示す場合もsource要素を残す。

主要fieldは必ず表の直接XPathから取る。`.//pat:PublicationNumber`、
`.//com:ApplicationNumberText`、`.//pat:FilingDate`、
`.//pat:Claims/pat:Claim`のようなdescendant検索は禁止する。P1には
`InternationalPublishingData`側の識別情報、JPBには
`PreviousPublishedDocument`側の識別情報、A1には`WrittenAmendmentBag`内の
claimsが存在し得るため、descendant検索は過去番号、国際出願情報、priority、
parent document、補正claimsを主要fieldへ混入させる。

`InternationalPublishingData`、`PreviousPublishedDocument`、
full publication内`WrittenAmendmentBag`の共存は、全件reportを補足する
代表XMLの直接確認で得た観察事実であり、全号・全kindでの出現を必須とは
しない。

full publication内の`WrittenAmendmentBag`は`amendmentContent` sidecarへ
分離し、root直下の`pat:Claims`と別に保持する。添付参照はroot直下だけでなく
`R//jppat:ReferenceFilesBag`を探索するが、安全な相対path、category、rootを
照合するまでST.26とは確定しない。

### 7.3 JPB固有fieldと日付

`B`は
`/jppat:RegisteredPatentPublication/jppat:RegisteredPatentPublicationBibliographicData`
である。

| field | XPath | cardinality・必須性 | 意味と欠損時 |
|---|---|---|---|
| B1/B2表示 | `B/pat:PlainLanguageDesignationText` | 出力`1`必須 | `DOCUMENT_LIST.kindCode`と照合。不一致は`確認候補` |
| 登録日 | `B/com:RegistrationDate` | 観察/出力`1`必須 | 登録処分の日付。欠損・不正dateは`取込失敗` |
| 登録公報発行日 | `B/jppat:PatentPublicationIdentification/com:PublicationDate` | 観察/出力`1`必須 | 公報が発行された日。`RegistrationDate`で代用しない |
| 登録番号 | `B/jppat:PatentPublicationIdentification/pat:PublicationNumber` | 観察/出力`1`必須 | B1/B2確定後、登録公報番号として保持 |

異議申立期限等で将来利用する日付候補は登録公報の`PublicationDate`であり、
`RegistrationDate`ではない。ただし、期限の算定、休日補正、法的評価は
本仕様の対象外である。

B1の期待表示は`特許公報(B1)`、B2は`特許公報(B2)`である。source valueを
NFC化し外側空白だけ除いた値をexact matchし、未知表示またはCSV kindとの
不一致はrecord未確定の`確認候補`とする。

### 7.4 A5/P5補正掲載event

| 区分 | `R` | `H` |
|---|---|---|
| A5 | `/jppat:UnexaminedPatentPublicationAmendment` | `R/jppat:UnexaminedPatentPublicationAmendmentHeader` |
| P5 | `/jppat:InternationalPatentPublicationAmendment` | `R/jppat:InternationalPatentPublicationAmendmentHeader` |

| field | XPath | 出力cardinality・必須性 | 規則 |
|---|---|---|---|
| event公開番号 | `H/jppat:PatentPublicationIdentification/pat:PublicationNumber` | `1`必須 | A5は10桁decimal string、P5は`WO` + 10桁。source valueを保持する。P5ではCSV/folderへ直接照合しない |
| event公報発行日 | `H/jppat:PatentPublicationIdentification/com:PublicationDate` | `1`必須 | `YYYY-MM-DD`。元公報日ではなく補正掲載eventの日付。不正値は`取込失敗` |
| 出願番号 | `H/jppat:ApplicationIdentification/com:ApplicationNumber/com:ApplicationNumberText` | `1`必須 | 抽出・保持するが、元P1との自動結合や無条件identity確定には使わない |
| 出願日 | `H/jppat:ApplicationIdentification/pat:FilingDate` | `0..1`任意 | 存在時は`YYYY-MM-DD`。欠損を推測補完せず、不正値は`取込失敗` |
| 補正対象category | `H/jppat:CorrectedPublicationCategory` | `1`を取込契約とする | source code/textを保持。未知値は`確認候補` |
| IPC | `H/jppat:IPCClassification/pat:MainClassification \| H/jppat:IPCClassification/pat:FurtherClassification` | `0..∞`任意 | full publicationのIPCへ自動上書きしない |
| FI | `H/jppat:NationalClassification/(jppat:MainNationalClassification\|jppat:FurtherNationalClassification)/pat:PatentClassificationText` | `0..∞`任意 | A5/P5 event側の分類として順序・suffix・facet・source valueを保持 |
| 補正内容 | `R/jppat:WrittenAmendmentBag` | `1`を取込契約とする | subtree、順序、種類を保持 |
| 補正claims | `R/jppat:WrittenAmendmentBag//pat:Claims/pat:Claim` | `0..∞`任意 | `amendedClaims`として別保存。本体claimsへ自動合算しない |
| 補正書提出日 | `R/jppat:WrittenAmendmentBag/jppat:WrittenAmendment/pat:FilingDate` | 公開仕様上、WrittenAmendmentごとに`1`必須。出力も`1`必須 | `YYYY-MM-DD`。出願日・event発行日と別field。欠損・不正値は`取込失敗` |
| P5国内公開番号 | `H/jppat:NationalPublicationNumber` | P5`0..1`、A5非該当 | P5 package keyとは別のoptional link identifier。欠損自体はidentity failureにしない。存在時は国内側10桁形式を独立検証し、空値・形式不正・重複はrecord未確定の`確認候補`。path／indexやevent番号との非等値だけでは未確定にしない |
| P5前回公開日 | `H/jppat:PreviousPublicationDate` | P5`0..1`、A5非該当 | `YYYY-MM-DD`。event発行日・出願日と別field。不正値は`取込失敗` |
| P5年次番号 | `H/jppat:AnnualNumber` | P5`0..1`、A5非該当 | opaque stringとして保持 |

A5/P5のFIと補正書提出日XPathは、2026-155号の代表XML観察ではなく、
[JPO公報仕様 第1.6版の公開公報（特許）文書構成](https://www.jpo.go.jp/system/laws/koho/shiyo/document/koujigou_vol16/1-3-2_bunsho_kousei.pdf)
の静的構造確認に基づく保守的な取込契約である。存在を2026-155号の観察値
として数えず、欠損を推測補完しない。

A5/P5のroot直下にはfull publication用`Description`、`Claims`、
`Abstract`がない。出願人名称、発明の名称、要約、full claims、
full description、登録番号の出力cardinalityは`0（非該当）`とし、関連する
A1/P1から暗黙にcopyしない。補正subtree内の断片は`amendmentContent`として
保持し、full fieldへ写像しない。

P5では`NationalPublicationNumber`、`PreviousPublicationDate`、
`AnnualNumber`がそれぞれ93件中49件で観察された。存在を必須にせず、
`NationalPublicationNumber`はP5 package keyとは別のoptional link identifierとして
source値を保持し、path／indexやevent番号との等値をidentity条件にしない。
存在時は国内側10桁形式、空値、cardinalityを独立検証する。`ApplicationNumber`は
抽出・保持するが自動link keyにしない。path／index欠損、番号・kind矛盾、
重複候補は`確認候補`であり、推測で結合しない。

### 7.5 日付fieldの意味

| 日付 | source | 意味 |
|---|---|---|
| ZIP号全体の発行日 | `ABSTRACT.publicationDate` | package metadata |
| 文献索引の発行日 | `DOCUMENT_LIST.issuePublicationDate` | 当該recordを収録した号の日付 |
| A1/P1公開日 | full XML `PublicationDate` | 公開公報の公開日 |
| A5/P5発行日 | amendment header `PublicationDate` | 補正掲載eventの発行日 |
| JPB登録公報発行日 | registered XML `PublicationDate` | 登録公報の発行日 |
| 登録日 | registered XML `RegistrationDate` | 登録の日 |
| 出願日 | `ApplicationIdentification/pat:FilingDate` | 出願の日 |

値が同じであってもfieldの意味を統合しない。

### 7.6 JPA/JPB主要差分

| 観点 | JPA A1/P1 | JPB B1/B2 |
|---|---|---|
| root | A1/P1で別root | 共通`RegisteredPatentPublication` |
| kind確定 | CSV `A`に加えてdirectory/rootが必要 | CSV `B1`/`B2`と`PlainLanguageDesignationText`を照合 |
| 登録日 | 非該当 | `com:RegistrationDate`あり |
| 要約 | 2026-155号では全件あり | B1は全件あり、B2は全件なし |
| `CONTENTS1` | publication number直後はapplication number | publication number直後にregistration dateを追加 |
| `CONTENTS2` | 17列 | 18列 |
| display flag観察値 | `請` | `早`、`際` |
| nested添付観察値 | ST.26 XML 36、legacy `.app` 7 | ST.26 XML 5、legacy `.app` 8 |

## 8. 繰り返し・mixed content正規化

### 8.1 source value・正規化text・検索用派生

本書では次を区別する。

- `source entry`: 処理中のZIP entry原byte列。path、size、hashを監査metadataとして
  別に保持する。
- `source value（raw）`: CSV cellまたはXML parserが一度decodeしたfield値に
  application独自のtrim/NFC等を加える前の値。CSVのpaddingを含む。
- `normalizedText`: 表示・保存用にLFとNFCを適用したtext。
- `searchText`: 検索専用の派生text。

XML parser標準の改行・entity decodeより前のbyte単位監査には`source entry`を
用いる。処理後もbyte単位監査を要する場合は、原byte列または同一byte列を
再取得できる保存先参照を保持する。hashだけを保持した場合に可能なのは
完全性照合であり、byte内容の再監査ではない。`source value`を「正規化後text」
の意味では使わない。

`normalizedText`は改行をLFへ統一し、Unicode NFCを適用する。段落外側の
不要な空白だけを整理し、次を行わない。

- NFKC
- 全角空白の一括collapse
- 内部空白の削除
- 外字代替表記の一律除去
- 複数値の並べ替えまたは無言のdeduplicate

`searchText`に限りNFKCと連続空白collapseを許す。派生変換後もsource value、
要素境界、順序、変換規則を追跡可能にする。

### 8.2 mixed content walker

`com:P`等は`.text`だけで抽出しない。各nodeを次の文書順で処理する。

擬似code:

```text
emit(node.text)
for child in node.children:
    walk(child)
    emit(child.tail)
```

childごとに`walk(child)`の直後へそのchildの`tail`を出す。全childの処理後に
tailをまとめて出してはならない。最後にparagraph、claim、section boundaryを
構造として確定する。

| node・表現 | 保存規則 |
|---|---|
| `com:Br` | 改行を挿入 |
| `B`、`I`、`U` | textを保持。必要ならstyle metadataをsidecarへ保存 |
| `Sub`、`Sup` | 構造を保持するか`_{...}`、`^{...}`の明示markerにする |
| `FigureReference` | 表示textと`@com:referencedFigureNumber`を保持 |
| `PatentCitation` | 既知handlerで表示text、識別子等の子要素、tailを順序どおり保持 |
| 未登録QNameのinline | descendant textを順序どおり保持し、QNameを`unknownInlineElement`として確認候補化 |
| `Image`、`Table`、`Math`、`ChemicalFormulae` | 安定placeholderを本文位置へ置き、参照metadataをsidecarへ保存 |

2026-155号で観察した表、数式、化学式は画像choiceであり、structured
MathML、inline formula、OASIS tableの実例はなかった。将来それらが現れた
場合も、descendant textまたは構造を保持し`未対応種別`／`確認候補`として
明示し、無言で除外しない。

### 8.3 画像・添付参照collector

次を独立した`0..∞`の参照として収集する。

| 種別 | XPath | 本文placeholder |
|---|---|---|
| paragraph直下image | `R//com:P/com:Image` | walkerの出現位置へ置く |
| table image | `R//com:Table/com:TableImage` | walkerの`Table`位置へ置く |
| math image | `R//com:Math/com:Image` | walkerの`Math`位置へ置く |
| chemical formula image | `R//com:ChemicalFormulae/com:Image` | walkerの`ChemicalFormulae`位置へ置く |
| drawings | `R/pat:Drawings/pat:Figure/com:Image` | 本文外sidecar。図番号を保持 |
| chosen drawing | `R/jppat:ChosenDrawingImage/com:Image` | 本文外sidecar |
| search report page | `R/jppat:SearchReportBag/jppat:SearchReport/jppat:PageImage` | 本文外sidecar |
| reference file | `R//jppat:ReferenceFilesBag/jppat:ReferenceFileBag/jppat:ReferenceFile` | 本文外sidecar。補正subtree内も対象 |
| foreign-language document | `R/jppat:ForeignLanguageDocumentBag/jppat:DocumentURI/@com:documentFileName` | 本文外sidecar |

inline walkerに現れるnodeだけ本文placeholderを置く。図面、選択図、検索報告、
外国語文書等の本文外参照はsidecarへ保存し、本文末尾へ無断連結しない。

sidecarは少なくとも次を保持する。

- `primaryEntryPath`、`sourceXPath`、文書内`ordinal`、親contextから決める
  `kind`
- `com:FileName`または`@com:documentFileName`のsource valueと安全な
  正規化相対path
- `com:ImageFormatCategory`、`com:HeightMeasure`、
  `com:WidthMeasure`、各`@com:measureUnitCode`
- source valueの`@com:imageContentCategory`、`jppat:ReferenceFileCategory`、
  図・表・参照番号
- 外国語文書では`@jppat:pageDocumentFormatCategory`と親
  `ForeignLanguageDocumentBag/@com:languageCode`
- `resolved`、`missing`、`rejected`、`notInspected`の参照解決状態

filenameは参照系で`1`必須、その他metadataは`0..1`とし、2026-155号で
観察された値が欠ける場合は`確認候補`とする。`Image`自身のcategoryだけで
種類を決めず、`Table`、`Math`、`ChemicalFormulae`等の親contextから
`kind`を決める。

collectorは1系統とし、`primaryEntryPath + sourceXPath + ordinal`を一意keyに
する。overlapするXPathまたは`amendmentContent`保存処理から同じnodeを
再登録しない。同じfileを異なる文書位置から参照するnodeは別参照として残す。

第8.3節のXPathとmetadataには、全件reportを補足する代表XMLの直接確認結果を
含む。特定号で観察した存在や必須性を他号・将来版へ固定せず、未知構造は
第10章の状態へ分類する。

### 8.4 請求項・明細書

- `pat:Claim`ごとにrecordを分け、`pat:ClaimNumber`とXML順を保持する。
- 明細書は段落単位に分け、`@com:pNumber`とXML順を保持する。
- paragraph/claim間は明示boundaryで連結し、隣接textを誤結合しない。
- 表、数式、画像placeholderの前後にあるtextとtailを失わない。

### 8.5 entity・外字

- XML predefined entity（`&lt;`、`&gt;`、`&amp;`等）は安全なXML parserで
  decodeし、結果文字を保持する。
- decode後の`<...>`形textをHTML/XMLとして再parseしない。本文中の配列表
  tag様文字列、とくに標準entityでescapeされたST.25型数値tag列もplain text
  として再escape可能な形で保持する。legacy`.app`添付とは別caseである。
- 外部実体、未知named entity、network entityは解決せず`取込失敗`とする。
- primary XMLではDOCTYPE、非標準named entity、PUA、数値文字参照は
  観察されなかったが、将来も存在しないとは仮定しない。
- JPO外字代替表記`▲…▼`、`△`、`□`、`〓`を文字化けとして削除しない。
  検索派生からmarkerだけを外す場合も、内側文字とsource valueを保持する。

## 9. 件数照合と整合性検証

### 9.1 別々に数える対象

- primary公報XML数
- nested ST.26 XML数
- path prefixから復元した文献directory数
- `DOCUMENT_LIST.csv` record数
- `CONTENTS1.csv` / `CONTENTS2.csv` record数
- A1/A5/P1/P5/B1/B2別件数
- 画像、legacy `.app`、その他添付数

XML拡張子総数や明示的directory entry数を文献数にしない。

### 9.2 2026-155号の回帰観察値

次の値は普遍的な固定値ではなく、2026-155号だけのLocal回帰oracleである。

| package/区分 | primary XML | nested ST.26 XML | `DOCUMENT_LIST` | `CONTENTS1/2` |
|---|---:|---:|---:|---:|
| JPA A1 | 810 | 10 | kind `A`の一部 | 810 |
| JPA A5 | 44 | 0 | kind `A5`の一部 | 対象外 |
| JPA P1 | 238 | 26 | kind `A`の一部 | 238 |
| JPA P5 | 93 | 0 | kind `A5`の一部 | 対象外 |
| JPA合計 | 1,185 | 36 | 1,185 | 1,048 |
| JPB B1 | 56 | B1/B2合計5 | 56 | B1/B2合計580 |
| JPB B2 | 524 | B1/B2合計5 | 524 | B1/B2合計580 |
| JPB合計 | 580 | 5 | 580 | 580 |

`ABSTRACT.csv`、virtual document folder、primary XMLの照合値:

| package/区分 | `ABSTRACT`集計 | virtual document folder | primary XML |
|---|---:|---:|---:|
| JPA A1 | 810 | 810 | 810 |
| JPA A5 | 44 | 44 | 44 |
| JPA P1 | 238 | 238 | 238 |
| JPA P5 | 93 | 93 | 93 |
| JPA合計 | 1,185 | 1,185 | 1,185 |
| JPB B1/B2合計 | 580 | 580 | 580 |

JPAの`DOCUMENT_LIST`は`A` 1,048件、`A5` 137件である。`A`は
A1 810 + P1 238、`A5`はA5 44 + P5 93に一致する。

JPA A1公開番号範囲の名目幅811件を、JPA全体またはA1の期待実件数にしない。
欠番、範囲外収録、補正掲載、nested XMLを別々に扱い、`ABSTRACT`集計、
directory、primary、`DOCUMENT_LIST`、`CONTENTS`間を集合で照合する。

添付参照の2026-155号観察値は、JPAのimage参照27,975件・その他添付43件、
JPBのその他添付13件で、全参照がZIP内entryへ解決し欠落0件であった。
これも固定のProduction期待値ではなくLocal回帰oracleとして扱う。

## 10. エラー・未知ケースの扱い

技術状態は次の4種とする。

| 状態 | 意味 |
|---|---|
| `取込成功` | 全必須判定・抽出・照合を通過 |
| `確認候補` | dataを保持できるが、矛盾・未知・任意fieldの異常を人間確認する必要がある |
| `未対応種別` | 安全に識別したが現parser契約の対象外 |
| `取込失敗` | 安全性または必須fieldを満たさずrecordを確定できない |

状態の対象levelはpackage、document、CSV file/record、attachmentに分ける。
roll-upは決定的に次のとおりとする。

- ZIP破損、不正path、重複正規化path等のcontainer安全性違反はpackage
  `取込失敗`とし、全処理を停止する。
- 個別XMLのparse/必須field失敗は当該documentだけ`取込失敗`とし、安全に
  次entryへ継続する。package集計は`確認候補`となり、完全件数一致を宣言
  しない。
- 必須CSVのrecord失敗は当該recordを採用せず、そのCSV fileを`取込失敗`、
  packageを`確認候補`とする。安全なprimary XML走査は継続してよい。
- attachmentの欠落・拒否は当該attachmentと参照元documentを`確認候補`に
  するが、抽出済み本文を削除しない。
- package自身が`取込失敗`でなくても、childに`確認候補`、
  `未対応種別`、`取込失敗`が1件以上あればpackageは`確認候補`とする。
  全childが`取込成功`のときだけpackageを`取込成功`とする。

| case | 状態 | 必須動作 |
|---|---|---|
| ZIP破損、中央directory不正 | `取込失敗` | package処理を停止し、展開しない |
| ZIP全体またはentry単位のresource上限超過 | `取込失敗` | 申告値と実測値を別々に検査し、超過時点でpackage処理を停止 |
| path traversal、絶対path、重複正規化path | `取込失敗` | entryを拒否しsecurity errorを記録してpackage処理を停止 |
| XML not well-formed、不正UTF-8 | `取込失敗` | 当該documentを確定せず、安全に次entryへ継続 |
| 外部実体・外部network参照 | `取込失敗` | 解決・fetchしない |
| 未知rootまたはnamespace | `未対応種別` | source metadataを隔離しprimary件数へ加えない |
| 未知kind | `未対応種別` | 推測で既知kindへ写像しない |
| root/path/kind/schema/番号の矛盾 | `確認候補` | primary recordを確定せず根拠を列挙 |
| 必須field欠損、不正date、full publicationのroot claims 0件 | `取込失敗` | A1/P1/B1/B2の不完全recordを成功扱いしない。A5/P5のfull claims非該当とは区別 |
| 任意field欠損 | `取込成功`または`確認候補` | 第7章の種別別規則に従い`null`と理由を保持 |
| CSV列数、count、文字長不一致 | `取込失敗` | 当該CSV recordを採用しない |
| CSV/XML件数または番号集合不一致 | `確認候補` | 差分集合を技術情報として記録 |
| duplicate publication number | `確認候補` | 自動merge/deduplicateしない |
| ST.26または添付参照 | `取込成功` | primaryと別recordで参照を保持 |
| 添付参照先欠落 | `確認候補` | 本文から参照を削除せずmissing状態を保持 |
| A5/P5 link不能・複数候補 | `確認候補` | full publicationへ結合しない |
| 未知mixed-content element | `確認候補` | 文書順textとelement名を保持し無言で捨てない |

これらの状態から「無効特許」「権利侵害」「期限徒過」等の法的結論を生成
しない。

## 11. 既知の制約・未確認事項

- `ABSTRACT.csv`の`01122`の意味は未確定である。
- 2026-155号以外の全公報種別、全schema版、全namespace変種を保証しない。
- XSD validation engineによる全primary XMLのschema妥当性検証は未実施である。
- 代表XMLはA1、P1、B1/B2を対象とし、A5/P5の代表XMLは含まれていない。
- 代表CSVはJPA側4論理fileであり、JPB固有列は全件調査結果に基づく。
- structured MathML、inline formula、OASIS tableの実例は未確認である。
- TIF/JPG/PDFの画像内容、OCR品質、配列表内容は未検証である。
- primary XMLで外部entity等が未観察でも、将来版での不存在は保証しない。
- 出願人contact等、XSD上の厳密cardinalityを調査結果だけで確定できない
  箇所は、本書の保守的な取込契約を適用する。
- 異議申立その他の法的期限計算、休日、送達、例外規定は対象外である。
- Production実環境、実画面、deploy動作は本仕様では未確認である。
- 本仕様で未確認と記載した事項を実装時に成功扱いしてはならない。

## 12. 実装受入条件

将来の公報XML parser実装Issueは、最低限次を満たすこと。本Issueでは実装、
fixture、test codeは作成しない。

- ZIPを全展開せずentry単位で処理する。
- ZIP source、中央directory、entry数、累積圧縮／非圧縮byte数、entry単位の
  圧縮／非圧縮byte数に上限を設け、申告値とstream実測値の両方で強制する。
- path traversal、重複path、外部実体、外部network解決を拒否する。
- A1/A5/P1/P5/B1/B2をroot、namespace、path、kind、番号、schemaの複合条件で
  識別する。
- P1の国内側XML番号をpath／indexへ照合し、P5ではevent国際公開番号と国内側
  package keyを分離する。P5のoptional national番号は別のlink identifierとして
  欠損を許容し、存在時は国内側10桁形式・空値・cardinalityを独立検証する。
  path／indexとの非等値だけでは未確定にせず、DOCUMENT_LIST重複候補では
  identityを確定しない。
- primary公報XML、nested ST.26、legacy配列表、画像等の添付を分離して数える。
- 第7章の対象fieldを種別別cardinality、必須性、欠損規則どおり構造化抽出
  する。
- 複数出願人、IPC、FI、claim、paragraphの順序と境界を保持する。
- mixed contentをtext→child→tailの文書順で処理し、表、数式、画像、
  unknown inlineを無言で欠落させない。
- B2の要約欠損を正常な種別差として扱い、A5/P5をfull publicationへ自動統合
  しない。
- JPBの`PublicationDate`、`RegistrationDate`、出願日を別fieldで保持する。
- `ABSTRACT`、`DOCUMENT_LIST`、`CONTENTS1/2`を各grammarでparseし、
  `01122`を分岐や件数判定に使わない。
- JPAの`CONTENTS2.recordLength`をUnicode文字数 + 論理改行1で検証し、予約
  spaceをsource cellで保持する。JPBの計算規則は未確認として成功扱いしない。
- full publicationの主要番号・日付・claimsは直接XPathだけで取得し、
  priority、過去公開、国際公開、補正claimsを混入させない。
- 図面、選択図、検索報告、本文内画像、表、数式、化学式、reference file、
  外国語文書を第8.3節のXPathとsidecar契約で収集し、参照解決状態を保持する。
- 未知caseを`確認候補`、`未対応種別`、`取込失敗`へ安全に分類する。
- fixtureは架空dataまたは公開可能dataのみを使い、A1/A5/P1/P5/B1/B2、
  nested ST.26、path traversal、外部entity、欠損、kind矛盾、mixed content、
  ZIPのentry数／中央directory／累積byte上限、CSV可変長/固定長を種別別にtestする。
  標準entityでescapeされたST.25型
  数値tag列を一度だけdecodeし、plain textとして保持するcaseも含める。
- 2026-155号の観察件数を用いる回帰検証はLocal環境でのみ実施し、固定の
  Production期待値にしない。
- XSD validationを実施していない場合は、その確認を成功と報告しない。
- parser出力は調査支援dataであり、法的判断を含めない。
