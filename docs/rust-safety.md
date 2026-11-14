# TLA+ の有限モデルを Rust で探索する

`compileTlaSafety` は tla-ts の parser が返す構文木から、有限モデル用 IR を作る。Rust コアが式を評価し、Init / Next の状態生成、BFS、重複排除、不変条件・deadlock の検査、反例復元を実行する。temporal property がある場合は、有限グラフと否定した性質の generalized Büchi automaton の積から、受理する SCC を探す。全状態グラフを TS で先に列挙する必要はなく、探索中に JS へ戻らない。

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

state は signed 32 bit 整数、真偽値、文字列、有限集合、有限関数を扱う。tuple / sequence は1始まりの有限関数、record は文字列をキーにする有限関数として等価性を判定する。値は immutable な arena に intern し、state はその ID を保持する。hash が衝突しても、型付き値の完全一致で重複排除する。

主な演算は次の通り。

- 非再帰 operator / 関数定義、LET、有限の全称・存在量化、tuple pattern。
- 加減乗算、比較、論理、IF、OTHER 付き CASE。整数 overflow はエラー。
- 集合の列挙・内包・写像、和・積・差・部分集合、SUBSET、UNION、Cardinality。
- 関数・record の生成、DOMAIN、適用、所属、EXCEPT。複数の更新は順に適用し、@ は各更新の直前の値。存在しない EXCEPT path では右辺を評価しない。
- sequence の Len / Head / Tail / Append / SubSeq / 連結、有限集合を要素にする Seq への所属。
- 変数全体への代入、有限領域からの選択、UNCHANGED、存在量化による action の列挙。

primed variable は、同じ分岐で代入した後に読み取る。部分的な関数更新を左辺に置く式から、未代入の変数を逆算しない。ENABLED は列挙可能な action に限り、fairness の subscript は候補ごとに評価できる必要がある。未代入の next variable に任意の値を補わない。

設定は INIT / NEXT または SPECIFICATION に、INVARIANT / PROPERTY / CONSTANT / CHECK_DEADLOCK を組み合わせる。SPECIFICATION は初期述語、全 state variable を列挙した subscript の `[][Next]_vars`、WF / SF の連言を扱う。PROPERTY は state / action predicate、論理結合、always / eventually / leads-to を扱う。action を含む一般の temporal property は `[]<>A` / `<>[]A` の範囲に限る。定数の ASSUME も確認する。

selected operator と依存を lower する compiler であり、全モジュールの SANY 検査や証明の処理ではない。未使用の定義・proof の正しさは判断しない。INSTANCE・ユーザーモジュール、高階・再帰 operator、model value、無限集合の列挙、temporal quantification、symmetry、state/action constraint は未対応。未対応の構文・設定は拒否する。全 tla-ts / TLC 互換を表す API ではない。

frontend の上限は、変数256、分岐4096、分岐あたり256 step、展開深さ40、bound variable 40。実行側も IR のフィールド・参照・式を検証する。複合値の深さは64で、それを超える state の生成はエラー。探索中は状態と親 index を保存し、temporal property がある場合だけ遷移グラフも保存する。

## 結果と予算

`complete` は reachable graph が閉じ、指定した不変条件・deadlock・property の検査が完了したこと。temporal property は fairness を満たす無限の振る舞いを対象にする。fairness を満たす振る舞いの存在を別途保証する結果ではない。`bounded` は探索予算切れ、`empty` は初期状態がないこと。いずれも合格へ読み替えない。

違反の区別は次の通り。

- `invariant-violation` / `deadlock` / `assumption-violation` は既存の違反名と trace を返す。
- `property-violation` は初期 state property または action property の違反。TLC がこれらを liveness violation と表示する場合も、この API では分ける。
- `liveness-violation` は無限に繰り返せる lasso を返す。`loopStart` がループの先頭 index、`loopAction` が最後の状態から先頭へ戻る遷移。

`PROPERTY P` の P が state predicate なら初期状態で検査する。`PROPERTY AlwaysP` の本体が `[]P` なら invariant として扱う。最短性を保証するのは BFS の safety trace。liveness の lasso は最短とは限らない。不完全な状態、型違い、overflow、不正 IR は例外となる。定数 FALSE の invariant / property も TLC と同じく探索前のエラーで、初期集合が空でも拒否する。

`maxDepth` / `maxStates` / `maxWork` は必須。`maxTemporalNodes` は property ごとの積グラフの上限で、既定値は `maxStates`。積の予算切れは `bounded` / `reason: "temporal"` になる。work は分岐の処理、binding の列挙、複合値の生成、automaton の展開・SCC 検査などで共有する。命令数、wall time、厳密なメモリ量の上限ではない。自動 timeout は追加しない。maxDepth の境界でも successor が既訪問状態だけなら complete にできる。

liveness では各状態に stuttering の自己遷移を追加する。WF は継続して有効な action、SF は無限回有効になる action の実行を要求する。deadlock は元の Next で判断し、自己遷移を追加して deadlock を隠さない。

trace の values は program.variables の順の PortableValue。set / map / record は正規化し、1..n を domain にする関数は list として返す。action は分岐の operator 名、初期状態は null、暗黙の自己遷移は `<stuttering>`。Driver 用 oracle にする場合は、仕様の値・操作名から実装の Action / Observation へ明示的に map する。

```sh
just safety-test
just safety-tlc java /path/to/tla2tools.jar
just safety-eval .artifacts/rust-safety-run
just safety-replay .artifacts/rust-safety-run
just complex-eval .artifacts/complex-run
just complex-replay .artifacts/complex-run
just complex-tlc /path/to/java /path/to/tla2tools.jar .artifacts/complex-tlc
just complex-tlc-replay /path/to/java /path/to/tla2tools.jar .artifacts/complex-tlc
```

[0009 の計画](../evals/plans/0009-rust-safety.md) に判定比較と性能条件を記録する。tla-ts 全体との性能比は、同じ仕様を扱う今回の fragment の範囲で解釈する。frontend・Wasm 起動・native process 起動を分けて測る。

[測定・差分検査・採用判断](../evals/iterations/0009-rust-safety.md) に、初回の改善不足、profile、literal decode と状態の連続格納の結果を記録している。

複合値・temporal の条件は [0012 の計画](../evals/plans/0012-collections-temporal.md)。検査は native / Wasm / tla-ts / TLC で比較し、反例の state と loop を固定した別の仕様で再生する。強制した遷移が元の Next または stuttering であること、全 trace state が到達すること、fairness と性質の違反を確認する。誤った性質を要求する対照は違反する必要がある。原文の [Channel](../evals/fixtures/channel/Channel.tla) も検査する。

[0012〜0014 の評価結果](../evals/iterations/0012-collections-temporal.md) に、対応検査と性能の改善・未達条件を記録している。`safety-eval` の既定 plan は0014で、任意の既存 plan を第2引数に指定できる。
