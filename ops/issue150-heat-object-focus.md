# Issue150: 熱機器Jの動作語誤抽出（case89）

監査原文SHA256 `3dc8d5cca22b3c9aea2cc9f52970818b129ee2ddb41d1809332cfd4254d6ff75`（5,866 bytes）。最初のsource partは完結JSONだが、releases_heat/absorbs_heatのJを機器名でなく動作語「放熱」「吸熱」へ引用しており、既存semantic validatorが正しく拒否した。review未到達、部分保存なし。

熱機器のreference/focus説明をpartitioned taskにも渡し、動作語でなく完全な原文の機器名をJへ引用する例を追加する。u/a、原文、schema/validator、6 source tasks/最大8送信、reasoning/output上限、retry/予約/署名を変更しない。元回答の書換えや自動補修は行わない。

オフライン原回答は引き続き拒否する。2つのJ参照だけを機器名にしたメモリ上の反事実は同part schemaを通るが、原回答として採用せず実AI成功の証拠とも扱わない。再比較・配備・通信は未実施。別OWNER未使用枠は保持。

## 一回限りの熱機器修正用財務補足（未承認）

現製品署名計画92,278円に、新AI2,000・image保持1,115・nonAI1,217・storage400・forward535の合計5,267円を追加する専用sourceHeatRepairEarmarkを定義。次の計画97,545円、月cap102,000円は据置。旧source-output/各修理/OWNER2,000円と未確定請求は全保持し、既失敗分を回収・再利用しない。

旧source-output署名を持つforward19のexact prior plan/profileから、新owner approval・新repair epochに結び付いた一回のforward20遷移だけを認める。base+4,732/pool remaining+535以外を拒否。停止19は実行不可、rebind・停止復帰・再署名で補足を再加算しない。既署名期限の延長も不可。このschema/decoder追加自体は実権・署名・配備を発行しない。

現bundle世代はsource-output-bundles-v7。新候補は別runtimeのsource-heat-bundles-v8として生成し、元v7を変更せずmanifest/source code pinで結び付ける。実current baselineは新承認後の範囲内で照合し、古い保持rawをcurrentと偽らない。case89未確定2000円と新比較2000円は別留保。

対象財務試験73件で旧schema互換・旧留保持続・一回固定額・新owner/epoch/exactprior・forward535の新1unit予約・20th超過・停止19/rebind再補充拒否・期限拒否を確認。製品の実AI成功とcurrent cloud ledger照合は未確認。
