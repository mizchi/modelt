# Go adapter の評価

[計画](../plans/0006-go-adapter.md) の範囲で、Go を独立した module として追加した。実装は `adapters/go`。照合の意味論は Rust/Wasm に任せ、Go は effect と callback、bytes と context、資源の所有を扱う。

## 確認した結果

- 共有 value fixture は valid 5件の canonical bytes が一致し、invalid 11件を拒否した。large integer、Unicode 順序、構造的 set / map を含む。
- Go の独立モデルと mutable counter で add/crash/restart を実行し、正常版 matched、永続化漏れ mismatch を確認した。正常版の oracle を JSON 保存後に再生し、同じ故障を再現した。これは人工故障の例であり未知バグ発見ではない。
- TS の有限モデルから9履歴を作り、batch と effect 経由のそれぞれで全 result を比較した。合計18比較で相違0。非決定的候補の履歴、初期観測の相違、不可能な操作、原本の async-mutex 修正前・修正後を含む。Go が JS の mutex を実行したわけではなく、TS が原本から観測した履歴を同じ表で検査した。
- TS の HostTape の最終 snapshot が一致した。長さ 0..16 の17組の削除候補も同じ順序で一致した。Go 自身の記録ホストや縮小ループの実装とは数えない。
- callback error、無効値、cancel、panic で cancel / Dispose を実行し、その後に新しい照合を実行できた。並行・再入・実行中の Close は busy、閉じた runtime と malformed artifact は error として拒否した。
- Go の JSON encoder が不正 UTF-8 の model name / state key を置換する挙動を Red test で確認し、送信前の検証で拒否するようにした。値だけでなくキーの識別も保持する。ABI の memory export を改名した実 Wasm も拒否し、module 内に memory があるだけでは受け付けない。
- `CGO_ENABLED=0 go test`、`go test -race`、`go vet`、gofmt が通った。Go 1.26.2 / macOS arm64、wazero v1.12.0。CI は Go 1.25.x / Linux amd64 で同じ検査を行う。
- SDK ソースを別ディレクトリへコピーし、別 module から offline / CGO 無効で実行した。uint64 最大値を保持し、縮小候補を取得できた。利用ガイドの Go snippet 自体を compile / run し、有限 toggle モデルとの matched を確認した。

`just check`、`just browser`、`just portable-test`、`just evaluate` / `just replay-evaluation`、`just package` でも既存経路を検査した。Go の検査は12 top-level tests。`just go-test` で fixture と consumer を再生成でき、`.artifacts/go` を CI artifact に保存する。

## 採用と制約

Go の接続先には Wasm ABI v1 を採用する。native 動的ライブラリやプロセスを必要とせず、既存 Rust コアと同じ観測の意味を使えるため。Go への checker の再実装や、言語間の速度比較は行っていない。

callback は context を尊重する必要がある。SDK は Go の goroutine を強制停止せず、自動 timeout も追加しない。Wasm 呼び出し中の cancel では instance が閉じるため、新しい Core が必要になる。1 worker につき1 Core を所有する。

BFS、PBT generator、goroutine scheduler、OS 障害注入、Go の HostTape 記録は次の範囲。Go の外部プロジェクトでの実バグ、導入時間、bundle / cold-start / throughput は未評価。今回の18比較を一般的な検出率や移植の完全性へ拡張しない。
