# 0004: TS / Rust の共通コア

[事前計画と収集処理の修正](../plans/0004-portable-core.md) に従い、値の契約、effect protocol、Rust の適合性照合・再生、TS/Wasm SDK を実装した。Go、BFS、共通 IR、PBT/shrinking の Rust 移植は今回の対象外。

## 意味論の照合

[確認 run](../runs/0004-portable-confirmation/) は Node 24.22.2 / Rust 1.98.0 / macOS arm64。seed121〜140、各512操作・最大深さ16の alternating corpus を使用した。

| 指標                                                |           結果 |
| --------------------------------------------------- | -------------: |
| 元の TS checker と TS ホスト＋Rust Wasm の結果比較  |        4,800件 |
| 判定・expected・実観測・反例・checkedSteps の不一致 |              0 |
| 正常対照                                            | 800 / 800 通過 |
| 同じホスト応答を使う native / Wasm の protocol 応答 |  116,564件一致 |
| 検出した既知の人工故障                              |          5 / 5 |
| 正常モデルから作った保存オラクルでの故障再現        |          5 / 5 |
| Wasm bytes                                          |        254,727 |

検出対象は永続化漏れ、重複処理、3回目のリトライ、配信順序の無視、drop の無視。未知の実プロジェクトのバグではない。native の大量比較は TS が処理したホスト応答の再生であり、native SUT の独立な大量探索を意味しない。Rust のモデルと mutable な実装の照合・故障再現は別の実行例と cargo test で確認した。

共有 fixture は大きい整数、集合の構造的な重複除去、写像のキー、UTF-8 と UTF-16 で順序が異なる文字、malformed input を含む。境界検査で Rust の null payload の余分な受理と、TS のエンコード失敗時の cleanup 漏れを見つけ、Red → Green で修正した。非決定的な履歴の矛盾、invalid、古い reply、失敗後の instance 再利用も検査した。Chromium で host import と cross-origin isolation を要求せず実行できた。

## 収集処理の失敗

[最初の run](../runs/0004-portable/) は1 seed の一致後、終了コード137で停止した。最小例で、新規 native process の ID が1、再利用した Wasm の ID が2になる不一致を再現した。両者の instance の lifecycle を揃え、巨大配列を一括 diff せず応答ごとに比較するハーネスへ修正した。最初の run は未完了のまま保持し、新しい seed で確認した。

確認 run のソースは commit `1f3d9f0` に保存した。run の source digest は manifest のファイルごとの SHA256 と照合できる。この commit で `node dist/evals/portable/replay.js evals/runs/0004-portable-confirmation` による5故障の再現と正常対照を確認した。その後の unused import の削除は意味論の変更を含まない。以後の CI の反復は独立した確認実験に数えない。

## 費用と判断

この run 全体は約4.66秒。累積時間は既存 TS の検査94ms、要求を記録する TS ホスト＋Wasm 経路2,940ms、native process の起動・入出力・再生・比較1,288ms。21 instance の Wasm 初期化合計は約8.49ms。計測対象と記録の費用が異なるため、実装言語の速度比として使わない。

共通コアを opt-in の経路として保持し、既存 TS の既定経路は維持する。意味論の共有とブラウザ可搬性の成立は確認できた。性能面の採用は、記録を外した同条件の比較と境界転送の profile を追加して判断する。次は transition の batch 転送、state handle、持ち運べる有限モデル IR を比較し、その後 BFS と縮小器の共有へ進む。
