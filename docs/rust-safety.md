# TLA+ safety を Rust で探索する

`compileTlaSafety` は tla-ts の parser が返す構文木から、小さい safety 用 IR を作る。Rust コアが式を評価し、Init / Next の状態生成、BFS、重複排除、不変条件・deadlock の検査、反例復元を実行する。全状態グラフを TS で先に列挙する必要はなく、探索中に JS へ戻らない。

```ts
import { compileTlaSafety } from "@mizchi/modelt/tla";
import { checkSafety, createPortableWasm } from "@mizchi/modelt/portable";

const core = await createPortableWasm(wasmBytes);
const program = compileTlaSafety({
  source: `---- MODULE Counter ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = x + 1
Safe == x < 3
====`,
  config: "INIT Init\nNEXT Next\nINVARIANT Safe",
});
const result = checkSafety(core, program, {
  maxDepth: 10,
  maxStates: 100,
  maxWork: 10000,
});
// invariant-violation、x=0,1,2,3 の最短反例。
```

ブラウザでは `wasmBytes` を fetch で読み込める。compiler は optional peer の tla-ts を使い、その公開エントリを browser bundle にする場合は既存の [browser test](../tests/browser.spec.ts) と同じ `node:zlib` → `fflate` の alias と未使用の `bun:jsc` の除外が必要。生成した `modelt.safety-program` v1 の JSON を保存すれば、実行側は tla-ts やこれらの alias を必要としない。Rust native の `modelt-core` binary は `{"version":1,"request":{"kind":"check-safety","program":...,"bounds":...}}` を1行の JSON として受け取る。Rust library は deserialize した `SafetyProgram` に `check(SafetyBounds)` を呼ぶ。native と Wasm は同じ探索コードを使う。

## 対応範囲

state は signed 32 bit 整数・真偽値。定数、非再帰 operator、加減乗算、比較、論理、IF、有限集合・整数区間への所属、変数代入、UNCHANGED、分岐を扱う。primed variable の読み取りは、同じ分岐でその変数を代入した後に行う。TLC の整数と同じく overflow は error で、wrap しない。

設定は INIT / NEXT / INVARIANT / CONSTANT / CHECK_DEADLOCK。定数の ASSUME も確認する。selected operator とその依存を lower する compiler であり、全モジュールの SANY 検査や証明の処理ではない。未使用の定義・proof の正しさは判断しない。INSTANCE・ユーザーモジュール、関数・record・sequence・state の set、量化、liveness・fairness・symmetry、state/action constraint などには未対応で、使用する構文・設定に含まれる場合は拒否する。全 tla-ts / TLC 互換を表す API ではない。

変数256、分岐4096、各分岐256 step、式・operator の展開深さ40を frontend の上限とする。実行側も IR のフィールド・変数参照・値・式の深さを検証する。Rust の状態集合は hash の一致だけに頼らず、型付き値の完全一致で重複排除する。探索中は状態と親 index を保存し、違反時だけ trace を復元する。

## 結果と予算

`complete` は指定したモデルの reachable graph が閉じ、検査対象の不変条件と deadlock 検査に違反がないこと。`bounded` は深さ・状態数・work の上限に達したこと、`empty` は初期状態がないこと。いずれも成功へ読み替えない。`invariant-violation` / `deadlock` / `assumption-violation` は違反名と反例を返す。不完全な状態、型違い、overflow、不正 IR は例外となる。

maxWork は分岐の guard / assign / choose / 終端を処理する回数。巨大な有限区間の列挙も途中で止めるための上限で、式ごとの命令数や wall time の上限ではない。自動 timeout は追加しない。maxDepth の境界でも successor が既訪問状態だけなら complete にできる。

trace の values は program.variables の順。action は分岐の operator 名で、初期状態は null。既存の Driver 用 oracle にする場合は、仕様上の値・操作名から実装の Action / Observation へ明示的に map する。TLA+ の内部状態がそのまま実装の API を表すとは仮定しない。

```sh
just safety-test
just safety-tlc java /path/to/tla2tools.jar
just safety-eval .artifacts/rust-safety-run
just safety-replay .artifacts/rust-safety-run
```

[0009 の計画](../evals/plans/0009-rust-safety.md) に判定比較と性能条件を記録する。tla-ts 全体との性能比は、同じ仕様を扱う今回の fragment の範囲で解釈する。frontend・Wasm 起動・native process 起動を分けて測る。
