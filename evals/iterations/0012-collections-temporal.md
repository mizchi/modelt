# 複合値・temporal と比較コストの評価

Rust native / Wasm backend は、有限集合・関数・record・sequence、有限量化、PROPERTY、WF / SF を扱える。[利用方法と制限](../../docs/rust-safety.md) を参照。tla-ts の parser から IR に変換し、状態生成から反例復元まで Rust 内で実行する。全 TLA+ の移植ではない。

## 判定と反例

[0012 の計画](../plans/0012-collections-temporal.md) を実装前に登録した。49入力は native / Wasm で一致し、予算付き入力と空初期集合を除く46入力は tla-ts と比較する。TLC では予算付き3入力を除く46入力を比較した。返却した反例14件には lasso 7件を含み、state と遷移を固定した別の仕様で再生した。誤った性質を要求する対照は liveness violation になった。

49入力の内訳は complete 23、invariant violation 3、property violation 4、liveness violation 7、deadlock 1、empty 1、bounded 2、error 8。error の1件は複合値の深さ64という実装上限の検査で、TLC / tla-ts へ無限モデルの完走を要求する対照には使わない。部分的な探索や型エラーを成功へ置き換えていない。

原文の [Channel](../fixtures/channel/Channel.tla) は8状態・16生成状態で一致した。revision・原文の digest・MIT License を保存した。tuple / 有限関数の等価性、EXCEPT の逐次更新と @、存在しない更新 path、1始まりの sequence、複数初期状態、deadlock と stuttering、WF / SF、複数の eventuality を検査した。

TLC ソースは `tlaplus/tlaplus` の `d8fb231de4e4b5d02c1b2ed1ac759c086f694021`。EXCEPT は `Tool.java`、関数の比較は `FcnRcdValue.java`、fairness の展開は `Liveness.java`、暗黙の stuttering は `Worker.java` と照合した。実行は TLC 2.19、jar の SHA-256 は `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。JRE と生ログは run の metadata に記録する。

開発中は、Seq 所属の型違いを FALSE として返す差と、tuple pattern の余分な要素を許す差が見つかった。Red を保存し、TLC と同じくエラーに修正した。最初の SF 対照は Tick の進行条件がなく、永久 stuttering を許していた。WF(Tick) を追加して、WF(Finish) と SF(Finish) の差を比較する条件に直した。強制再生側も、temporal な PROPERTY を INVARIANT として設定した誤りと、action property の再検査方法を修正した。これらを未知の実システムのバグ発見には数えない。

## 性能と改善

条件は固定10入力、warmup2・測定7、経路の順序を交互にする。macOS arm64、Node24.22.2、Rust1.98.0、tla-ts0.0.10 の1台で測定した。native は process 起動を含み、Wasm は生成済み IR の request、tla-ts は frontend を含む検査。frontend と Wasm 起動を別に測る。言語だけの比較や、実 SUT を含む end-to-end の費用ではない。

0012 の複合値は scalar と違って遅かった。[0013](../plans/0013-scalar-comparison.md) で、整数・真偽値の比較がエラー文字列を確保する経路を除いた。[0014](../plans/0014-value-hash.md) では、intern table の整数を直接混ぜる private hasher に変更した。hash が衝突した異なる関数を実際に構成するテストで、値と ID が分離されることも検査する。暗号的 hash の用途には使わず、Cell 全体の Eq を残す。

| 入力 | 0012 native / Wasm | 0013 native / Wasm | 0014 native / Wasm |
| --- | ---: | ---: | ---: |
| 集合配送、4096状態 | 37.96 / 31.53 ms | 17.89 / 21.71 ms | 17.31 / 19.45 ms |
| function、4096状態 | 37.92 / 32.92 ms | 20.80 / 25.22 ms | 17.32 / 20.84 ms |

各段階の49入力・結果・work・反例・再生仕様は、直前の保存結果と完全一致した。run 間で同時測定の tla-ts も変動するため、小さい時間差を原因の確定や一般的な改善率と解釈しない。

最終0014の中央値は次の通り。全10入力の生サンプルは [保存した benchmark](../runs/0014-value-hash-performance/benchmark.json) にある。

| 入力 | tla-ts | native process | Wasm request |
| --- | ---: | ---: | ---: |
| 集合配送、4096状態 | 16.64 ms | 17.31 ms | 19.45 ms |
| function、4096状態 | 11.89 ms | 17.32 ms | 20.84 ms |
| queue、2047状態 | 3.67 ms | 4.37 ms | 2.55 ms |
| fairness ring、128状態 | 1.81 ms | 4.99 ms | 2.17 ms |
| scalar ring、10万状態 | 40.43 ms | 15.51 ms | 18.74 ms |

scalar ring は同時測定の tla-ts に対して native 約2.6倍、Wasm 約2.2倍。queue の Wasm も約1.4倍だった。集合・関数・小さい temporal モデルについて、速度目的の一律切替は採用しない。複合値の対応と再現性のために Rust backend を利用し、比較時の割り当て除去と private hasher は今回の固定入力での改善として採用する。Wasm は983035 bytes、起動測定は約1.36 ms。

次の速度改善は、EXCEPT の値コピー、集合・関数の正規化、積グラフの割り当てを profile で分けてから選ぶ。今回、メモリ使用量、並列 BFS、temporal な無限モデル、実分散システムの未知バグ検出は評価していない。

## 保存と再実行

| 段階 | snapshot | 判定・反例 | 性能 | TLC |
| --- | --- | --- | --- | --- |
| 0012 | `65d94dc` | [checks](../runs/0012-collections-checks/result.json) | [performance](../runs/0012-collections-performance/result.json) | [TLC](../runs/0012-collections-tlc/result.json) |
| 0013 | `aadde5d` | [checks](../runs/0013-scalar-checks/result.json) | [performance](../runs/0013-scalar-performance/result.json) | 0012の原本を維持 |
| 0014 | `1288718` | [checks](../runs/0014-value-hash-checks/result.json) | [performance](../runs/0014-value-hash-performance/result.json) | [TLC](../runs/0014-value-hash-tlc/result.json) |

最終 sourceVersion は `53d7adcdbfe8fc0029af08106dbfeb9a7152ba02fed17a44c52582938169acd3`。各 replay は source・Wasm・保存ファイルの digest を検査する。過去 snapshot の run はその snapshot に checkout して再実行する。0013 / 0014 の判定 run は親の digest と全 report も比較する。旧 run は上書きしていない。

```sh
just complex-replay evals/runs/0014-value-hash-checks
just safety-replay evals/runs/0014-value-hash-performance
just complex-tlc-replay /path/to/java /path/to/tla2tools.jar evals/runs/0014-value-hash-tlc
```

共有テストは Vitest / node:test それぞれ68件。Rust、native / Wasm 差分、実 Chromium、Go の CGO無効 / race / vet / 外部 consumer、npm / Cargo / Wasm の単独 consumer も確認した。mutation score は既存の TS counter 対象で95.4%、Rust checker の mutation coverage を表す値ではない。[検証ログ](../runs/0014-verification/result.json) に結果と Red を保存した。
