# Go adapter

## 仮説と範囲

Go から既存の Wasm ABI v1 を駆動すれば、照合ロジックを再実装せず Go の SUT と同じ有限モデル・保存オラクルを照合できる。`adapters/go` を独立 module とし、CGO 不要の wazero v1.12.0 を固定する。Wasm bytes は利用者が渡し、SDK はネットワークや外部プロセスを必要としない。

対象は Go のモデル callback、Driver、有限モデル、履歴 batch、オラクル再生、縮小候補、HostTape の検証。BFS、PBT generator、Go の goroutine scheduler、OS 障害注入、Go でのホスト実装は対象外。性能向上は主張しない。

## 結果を見る前の条件

- 共有 portable-value fixture の valid 全件を同一 canonical bytes にし、invalid 全件を拒否する。整数を float64 に変換しない。
- Go の独立モデルと mutable SUT で add/crash/restart を実行し、正常版 matched と永続化漏れ mismatch を得る。正常版の保存オラクルを再生して同じ故障を再現する。
- 非決定性は単一履歴で候補を絞り、不可能な操作は Driver.step を呼ばず invalid にする。
- callback の例外・context cancel は error にする。pending session の cancel と Driver.dispose を確認し、キャンセル後に再利用可能か、閉じた runtime なら error になることを確認する。並行・再入は busy としセッションを混ぜない。
- TS checker が判定した有限モデルの履歴を Go/Wasm と比較する。既存の async-mutex 原本の修正前・修正後、初期観測の相違、不可能な操作を含む。status だけでなく expected / actual / trace / checkedSteps を比較する。
- 同一 HostTape の snapshot と長さ 0..16 の縮小候補を TS の結果と比較する。
- CGO_ENABLED=0 の go test、race、vet、gofmt と別 module の consumer を検査する。Node の既存検査と実ブラウザ検査も実施する。

新しいバグ発見・検出率・性能改善とは数えない。結果は `evals/iterations/0006-go-adapter.md` に記録し、再実行用データは `.artifacts/go` に生成する。
