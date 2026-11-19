# Maintained open-state extraction

The source validator rejects an `opens` action quote containing an occurrence
of `開いた` immediately followed by `状態を維持`. That occurrence describes a
state being maintained, not a newly asserted opening. Widening the quote to
include an earlier active opening cannot make the later state an opening.
An independently printed active opening still has its own fact and occurrence.
The checklist cue remains available to a complete `maintains` fact; source
instructions explicitly allow that existing alternative and require the full
state and maintenance verb in its action and object quotations.

The retained case96 source audit demonstrates this validation gap and is kept
unchanged privately. Replaying it against the fixed validator rejects the
unsupported opening. Synthetic controls are regression inputs, not repaired
historical answers or accepted comparison results. This narrow grammar check
does not establish complete Japanese semantic correctness.

The generation request's earlier non-2xx response remains a separate unresolved
upstream failure. This change does not identify that HTTP cause, retry an old
operation, release UNKNOWN holds or independently authorize another paid run.

## 完全文の再利用

生成時は側、技術的主語、全条件、述語、対象を含む完成文を先に作り、同じ事実を共通点・相違点へ使う際に再要約しない。維持を開くへ変えることや、側のラベルだけを残して技術的主語を省くことを防ぐための指示である。各欄の独立した原文照合、文字数上限、失敗時の保存拒否は維持する。生成後の文章補修は行わない。

この変更のローカル試験は指示が実際の生成要求へ渡ることと既存の保存検証経路を確認する。モデルが次回に指示を守ることや、実AIの品質受入を保証するものではない。
維持動作のreview抽出は、原文抽出と同じく状態・値と維持動詞までを含む完全句をobjectsへ残す。状態名詞だけの抽出を正常な完全句と同一視するための一般的な動詞削除は追加しない。型付きmaintainsの完全句が「を／に／が維持する」で終わる場合は、検証済みの句を一度だけ描画する。従来の名詞objectには従来の述語付加を保つ。他predicateや文中の「維持する」にはこの処理を適用しない。原AI応答と検証結果を後から修正して合格にしない。