# 同じオラクルで TS / Rust / Go を検査する

`evals/cross-language` は、共通の finite model と portable trace を各言語の実装へ渡す評価ハーネス。記録済みの観測を Driver から返す0006の互換性テストに加え、各実装を操作して新しい観測を得る。

```sh
just cross-test
just cross-eval development .artifacts/shared-dev
just cross-eval confirmation .artifacts/shared-confirm .artifacts/shared-dev
just cross-replay .artifacts/shared-confirm
```

run directory は新しい名前にする。存在する run を上書きしない。confirmation は development と同じ source fingerprint を要求し、別 seed を使う。CI は確認用 seed の再実行を regression として扱う。

## 共有するもの

実験用の `modelt.oracle-suite` v1 container に、共通の `modelt.finite-model` v1、case ID、fault 名、`modelt.portable-trace` v1 をまとめる。oracle は仕様の initial / step だけで作り、実装の観測から生成しない。Rust と Go の SUT module は model table や期待観測を受け取らず、操作だけを受け取る。

| 経路             | 実行内容                                             |
| ---------------- | ---------------------------------------------------- |
| 有限モデル照合   | 実装へ reset / step し、共通表の許容観測と比較       |
| 保存オラクル再生 | 新しい実装へ同じ操作列を渡し、保存した期待観測と比較 |
| 反例の再現       | 保存した仕様 oracle を故障版・正常版へ渡し直す       |

TS は既存の checker、Rust は native `Session`、Go は Go adapter と Rust/Wasm を使う。モデルと checker を3種類独立に実装したという意味ではない。TS は元の executable model とも結果を突き合わせる。

## 実装と障害

仕様は既存の durable counter。id a / b、amount1、通信キュー最大2の有限領域に限定する。mutable な TS・Rust・Go の実装は、永続データ、メモリ、重複排除、通信キューを持ち、add / send / deliver / drop / crash / restart を実行する。

正常版と、既知の persistence / deduplication / late-retry / fifo-only / drop-ignored を比較する。各 case は fresh SUT で始め、初期観測から検査する。status だけでなく actual / expected / trace / checkedSteps と Driver の reset / step 数を照合する。

実装の場所:

- TS: `examples/durable-counter.ts`、`evals/harness/counter-faults.ts`
- Rust: `evals/shared-oracle-rust/src/lib.rs`
- Go: `adapters/go/internal/counter/counter.go`

Rust / Go の runner は stdin の同じ suite を読む。Go command は実験用で、SDK の public API ではない。

```sh
evals/shared-oracle-rust/target/release/modelt-shared-oracle < .artifacts/shared-confirm/suite.json
.artifacts/go/counter-replay crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm < .artifacts/shared-confirm/suite.json
```

## 証拠と範囲

`suite.json` に共有入力、`matrix.json` に全 case / fault の判定と result digest、`witnesses.json` に仕様 oracle と実際の失敗観測を別々に保存する。`manifest.json` に source fingerprint、入力を処理した binary の digest と toolchain、`result.json` に集計と証拠ファイルの digest を記録する。

`cross-replay` は保存した suite と witness を読み、同じ source / core Wasm と証拠の digest を検査する。生成器を再実行して oracle を置き換えない。

ここで確認するのは、人工故障に対して同じ oracle が3言語の実装を検査できること。未知バグ発見、任意プログラムの refinement、OS の実障害、goroutine / thread の自動 scheduling、無制限の履歴探索、速度向上は対象外。[評価計画](../evals/plans/0007-shared-oracle.md) を参照。
