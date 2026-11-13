# TS / Rust の共通コア

`crates/modelt-core` は有限モデル、適合性照合、保存オラクルの再生、縮小、ホストの記録・再生を実装する Rust crate。同じソースを native と Wasm で使う。TS SDK は `@mizchi/modelt/portable`。既存 TS checker は独立した比較対象として残す。[有限モデル・縮小・ホストの使用例](using-models.md) と [配布手順](releasing.md) を参照。

## 実行

```sh
rustup target add wasm32-unknown-unknown
just portable-build
just portable-test
cargo run --manifest-path crates/modelt-core/Cargo.toml --example counter
just portable-eval
just portable-replay evals/runs/<run-id>
```

Node の例。読み込み・配信はホストが所有する。

```ts
import { readFile } from "node:fs/promises";
import {
  checkPortableConformance,
  createPortableWasm,
} from "./src/portable.js";
import { counterModel, createCounter } from "./examples/durable-counter.js";

const core = await createPortableWasm(
  await readFile(
    "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
  ),
);
const result = await checkPortableConformance(
  core,
  counterModel,
  createCounter(),
  [{ type: "add", id: "a", amount: 1 }, { type: "crash" }, { type: "restart" }],
);
if (result.status !== "matched") throw new Error(JSON.stringify(result));
```

ブラウザは `fetch()` の bytes を渡す。Wasm の host import は0。コア単独では SharedArrayBuffer や COOP/COEP は不要。Z3 の配信条件は従来どおり。

Rust は `Session::new(model, actions)` / `Session::replay(trace)` を使う。`effect()` の要求を実行し、`resume(id, response)` で戻す。`examples/counter.rs` は独立した Rust モデルと mutable な実装を照合し、正常版のオラクルを永続化漏れの実装で再生する。

## 値とトレース

値は `type` と、必要な型だけに `value` を持つ tagged JSON。null は `{"type":"null"}`、整数は `{"type":"int","value":"9007199254740993"}`。[共有 fixture](../fixtures/portable-values.json) で canonical bytes を検査する。

| 型                   | 意味                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| null / bool / string | Unicode scalar string。Unicode 正規化はしない                                          |
| int                  | `0` または先頭ゼロのない符号付き十進文字列。`+1`、`-0`、浮動小数点を拒否               |
| bytes                | 小文字の偶数桁 hex                                                                     |
| list                 | 順序を保つ列                                                                           |
| record               | `[field, value]` の列。field の UTF-8 byte 順、重複を拒否                              |
| set                  | 要素の canonical JSON の UTF-8 byte 順。構造的な重複を除去                             |
| map                  | `[key, value]` の列。key の canonical JSON の UTF-8 byte 順。正規化後の重複 key を拒否 |

`toPortableValue` は plain record、safe integer、bigint、Set、Map、Uint8Array を変換する。`fromPortableValue` は safe 範囲の int を number、それ以外を bigint にする。小さい bigint と number の元の型は区別しない。map key は構造的な値として扱い、object identity は保存しない。順序が意味を持つ集合は list にする。

トレースは `format: "modelt.portable-trace", version: 1` で従来の Trace v1 と区別する。`toPortableTrace` で変換し、`encodePortableTrace` / `decodePortableTrace` で保存する。`checkPortableTrace` には Driver と action decoder を渡す。期待オラクルはモデルや信頼した実装から作る。故障版の実観測を新しい正解へ置き換えない。

## Effect protocol

全 command は `{"version":1,"request":...}`。native CLI は stdin/stdout の1行1 JSONで同じ command / message を処理する。エラーは `kind: "error"` を返し、検査の成功に変換しない。

| request.kind | 操作                                                     |
| ------------ | -------------------------------------------------------- |
| canonicalize | portable value の検証と正規化                            |
| start        | モデル名と操作列からセッションを開始                     |
| replay       | portable trace を再生                                    |
| resume       | pending effect の id と transitions / observation を返す |
| cancel       | pending effect の id を照合して破棄                      |

`kind: "effect"` の中身は `model-initial`、`driver-reset`、`model-step`、`driver-step`、`done`。`model-step` は候補状態と操作を渡す。ホストは key・state・observation の遷移候補を返す。観測に合う候補を履歴全体で絞り、同一 key には最後の state を採用する。全候補が操作不能なら Driver を実行せず `invalid` にする。従来の TS checker と同じ意味で照合する。

同じ Engine / Wasm instance で実行できるセッションは1つ。effect ID は instance 内で単調増加し、古い応答、異なる種類の応答、実行中の二重 start を拒否する。TS SDK は終了時に Driver を dispose し、例外時は cancel する。並列タスクには独立した instance を割り当てる。

TS SDK は state / action / observation の encoding を差し替えられる。state と action は将来の振る舞いを識別できる忠実な値にする。異なるモデル key が同じ state の符号化へ潰れた場合は拒否する。観測の抽象化は observation encoder に置く。custom comparator はこの経路では受け付けない。モデルと Driver は immutable な snapshot を返す。

## Wasm ABI v1

`modelt_abi_version()`、`modelt_input_resize(length)`、`modelt_dispatch()`、`modelt_output_ptr()`、`modelt_output_len()` を公開する。resize が返す線形メモリへ UTF-8 JSON をコピーし、dispatch 後に出力を読む。ptr / length は i32 を unsigned として扱う。出力とメモリ view は次の呼び出しより前にコピーする。Rust の struct layout や JS 固有の glue に依存しない。

コアは I/O、時計、乱数、thread、テストランナーを所有しない。Promise や goroutine の順序制御はホストが担当する。Rust CLI は外側で標準入出力を提供する。

## 初版の範囲

Rust は値・適合性・再生に加え、観測付きの有限表を読み、縮小と HostTape を検査できる。BFS、モデル合成、fast-check による生成、TLA+、SMT、budget/sharding は既存 TS 経路を使う。任意の TS 関数の変換、汎用の言語 IR、Go SDK は含まない。配布 archive と単独 consumer を検証し、registry の初回公開はユーザー操作として残している。[0004](../evals/plans/0004-portable-core.md) と [0005](../evals/plans/0005-usable-core.md) の計画・評価を参照。
