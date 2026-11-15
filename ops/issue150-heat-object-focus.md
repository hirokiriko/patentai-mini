# Issue150: 熱機器Jの動作語誤抽出（case89）

監査原文SHA256 `3dc8d5cca22b3c9aea2cc9f52970818b129ee2ddb41d1809332cfd4254d6ff75`（5,866 bytes）。最初のsource partは完結JSONだが、releases_heat/absorbs_heatのJを機器名でなく動作語「放熱」「吸熱」へ引用しており、既存semantic validatorが正しく拒否した。review未到達、部分保存なし。

熱機器のreference/focus説明をpartitioned taskにも渡し、動作語でなく完全な原文の機器名をJへ引用する例を追加する。u/a、原文、schema/validator、6 source tasks/最大8送信、reasoning/output上限、retry/予約/署名を変更しない。元回答の書換えや自動補修は行わない。

オフライン原回答は引き続き拒否する。2つのJ参照だけを機器名にしたメモリ上の反事実は同part schemaを通るが、原回答として採用せず実AI成功の証拠とも扱わない。再比較・配備・通信は未実施。別OWNER未使用枠は保持。
