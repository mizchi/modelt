# 0005: 実バグ・共通モデル・縮小・実行環境

実装前に条件を固定する。現状の照合コアを、同じモデルを持ち運んで実際の修正前後を検査できる形へ進める。実行結果を見て故障条件やモデルを弱めない。

## 過去バグ

対象は DirtyHairy/async-mutex の修正 `8331143c133585ae41b35b69dab7404e2f66751e` と親 `e7bc6a43c9a8f43971150ebd6f51f829d60b97ef`。修正は unscoped release の再入時に新しい releaser を消してしまう問題。公開の元ソースと MIT ライセンスをそのまま固定し、SHA256 を保存する。型検査と formatter は vendored source を除外し、bundler が原本をコンパイルする。

契約は FIFO mutex の acquire/release、観測は granted IDs と isLocked。モデルと実装の遷移を共有しない。非同期 acquire を待ち続けず、Node の event-loop turn まで進めて Promise の反応を観測する。この原本は外部 I/O を使わない。これは指定した観測境界での検査で、無制限の liveness 証明ではない。

開発は既知の upstream regression と小さい全列挙。確認用 seed161〜180、256 reset/step・最大深さ10の有効操作 corpus を予約する。修正前の mismatch、修正後の matched、保存反例の再現を必須にし、invalid・例外・未検査を合格にしない。手法・Driver の作業時間は推測せず、作業記録上の wall time と自動実行時間を区別する。

## 共通の有限モデルと縮小

既存 Model から初期状態・state key・観測付き遷移・不変条件の違反ラベルを含む versioned な有限表を出力する。閉じていないモデルを完全な artifact として出さない。TS と Rust でロードし、同じ操作・観測を検査する。未知 version、重複 key、存在しない target を拒否する。初期観測を state 固有と仮定せず、edge ごとに観測を保持する。

縮小は削除候補の順序を共通化し、毎回モデルでの有効性と元の失敗の再現を確認する。最小性は1要素削除の意味に限定し、候補数 budget で bounded を返す。invalid を反例として採用しない。元のモデル・生成法を変えず、上記の保存反例で長さと追加実行数を比較する。

## 性能・ホスト・配布・CI

- 同じ保存した操作・観測・有限表で TS、Wasm、native の照合を比較する。記録なし、cold start と warm、入力転送と検査を分ける。warmup3、測定9、実行順を交互にする。checksum/判定一致を必須にし、異なる仕事の時間を言語の速度比としない。
- 時計・PRNG・メッセージキュー・永続化と crash/restart を注入可能な pure TS host を追加する。選択を versioned tape に保存し、異なる要求や未消費の tape を拒否する。実 OS を透過的に制御する機能にはしない。
- npm と Cargo の配布 artifact を作り、別の consumer から import / cargo build / Wasm 実行する。最初の npm publish と OIDC 登録は npm-release skill に従うユーザー操作として残す。registry 書き込みや tag 保護変更は実施しない。
- PR の軽い検査は単一 job に集約し、二重 push/PR 起動を避ける。重い独立評価と4 shard は workflow_dispatch / 定期実行に残す。欠落を成功に変えない。

結果・失敗・source digest・upstream provenance・次の判断を evals/runs と iteration に保存する。確認用 seed の CI 再実行は独立した新実験には数えない。
