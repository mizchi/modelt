# 非同期履歴と再利用・探索の評価

## 固定する意味と範囲

- `modelt.concurrent-history` v1 は invoke / return / fail / unknown / cancel を operation id で対応させる。return だけが実時間順序の終端を作る。fail は作用なしを確認した失敗、unknown / cancel / outcome なしは作用した可能性を残す。未完了操作は省略または線形化できる。未完了を成功・失敗へ決め打ちしない。
- TS の独立 checker と Rust native / Wasm、Go SDK で同じ有限モデルと履歴を判定する。ノード予算切れは inconclusive、空履歴は empty。availability や無限の liveness を主張しない。
- 正常・lost-update の並行 counter、commit 後の応答喪失、cancel、確定失敗、重複 id、不正イベント順、予算境界を固定対照にする。
- 永続値と dedup 情報の分離保存による retry、partition 復旧後の古い fencing token / lease、障害停止後の bounded recovery、retry + queue + storage の合成、対称 id の置換と独立操作交換、緩めたモデルの誤実装受理を追加パターンとして検査する。人工故障・小モデルの範囲を記す。

## 最適化候補

- load-model / release-model と instance ごとの単調増加 handle。読み込んだ有限モデルを索引化し、状態・操作の線形検索を減らす。古い handle、他 instance の binding、使用中の解放、既存 API と結果の違いを検査する。
- TS trace の内部蓄積で毎 step の配列コピーを除く。返却 snapshot と失敗 prefix を維持する。
- 縮小はモデルでの preflight と、producer / consumer の依存閉包削除を追加する。元の単一削除も残し、failure signature と最終 SUT 再現を要求する。
- feedback は操作種別間の順序・配送 index・retry / crash の関係を使い、一定割合の無作為選択を維持する。既存 uniform / alternating と同予算で比較する。既知故障の名前を生成器へ渡さない。

## 事前に固定する評価条件

開発 seed231〜235、確認 seed241〜260。既存 counter の5故障と正常版、alternating と feedback、各512 reset/step、深さ16。未検出も記録し、新しい seed と同一 source で確認する。case 数・要求操作・モデル検査回数・SUT call・初回検出位置・再現を記録する。throughput だけで採用しない。確認結果を見て条件を変更しない。

性能は同じ5操作の正常履歴を batch1 / 16 / 64で繰り返す。49状態の mutex と512状態の ring、warmup3・測定9で順序を交互にする。旧 wire reload と handle 再利用は同じ indexed checker を使い、load / 正規化と定常照合の費用を区別する。完全な結果の一致が前提で、速度の合否閾値は置かない。

run は排他的に作り、source / 入力 / witness / 結果 / toolchain と digest を保存する。過去 run は編集せず、再生で保存反例と正常対照を確認する。性能・feedback は実装したことと採用判断を分ける。汎用 goroutine / thread scheduler、透過的な OS 故障、POR / symmetry による探索省略、全 TLA+ / SMT 移植は含めない。
