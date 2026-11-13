# modelt

TypeScript のモデルと実装を比較する試作ライブラリ。モデルからのオラクル生成、差分テスト、反例を縮小する property-based testing を、Vitest・`node:test`・ブラウザで実行する。

`tla-ts` を TLA+ エンジン、`z3-solver` を Z3 Wasm ランタイムとして利用する。Quint Connect のモデルと実装をつなぐアプローチを参考に、TS の `Driver` を実装との境界にした。Quint 言語や Apalache の再実装ではない。

## 実行

観測付きの有限モデルを TS / Rust で共有する方法、反例の縮小、時計・通信・永続化の注入は [利用ガイド](docs/using-models.md) を参照。`just package` で solver を必須にしない npm/Cargo/Wasm archive と CLI を作り、別 consumer で検証できる。[公開手順と CI の分割](docs/releasing.md) は別途記載している。

Node.js 24+、pnpm、just を使う。npm には未公開。

```sh
pnpm install --frozen-lockfile
just check
just demo
just mutation
pnpm exec playwright install chromium
just browser
```

`just check` は lint、型検査、Vitest、`node:test` を実行する。共通の挙動テストを両ランナーに登録している。`just mutation` は `@mizchi/mutator` で TS ソースを変異させ、Vitest で検査する。

評価と改善のループは `just eval-loop`、保存した故障の再現は `just replay-loop`。[evals/](evals/README.md) に仮説・条件・run・判断・次の仮説を残す。初回の幅広い比較は `just evaluate` / `just replay-evaluation` で再実行できる。実験用の探索器・履歴 checker は public API に含めない。

時間・メモリから worker 数と探索深さを選ぶ `./budget`、独立 task の分割・集約を行う `./sharding` を追加した。[実行時間・Rust・cloud sharding の評価](evals/runtime/README.md) と [測定結果](evals/iterations/0003-runtime.md) を参照。Rust/Wasm は実験用カーネルとして分離している。

## モデルと実装の比較

TS / Rust の共通コアは `./portable`。同じ Rust ソースを native と Wasm で使い、適合性照合とトレース再生を行う。[Go adapter](docs/go-adapter.md) は CGO 不要で同じ Wasm に接続する。[値・effect protocol・使用例](docs/portable-core.md) を参照。`just portable-build` / `just portable-test` で Rust と Node・実ブラウザ、`just go-test` で Go の照合と単独 consumer を検査する。

[共通オラクルで3言語の実装を動かす評価](docs/shared-oracle.md) は `just cross-test`。同じ有限モデルと保存 trace を使い、正常版・故障版の TS / Rust / Go を直接操作して比較する。

[非同期履歴とモデル再利用](docs/async-history.md) は `./history` と `loadFiniteModel`。未完了・結果不明の操作を含む照合、索引付き handle、依存関係を使う縮小と探索 feedback の評価は `just async-test` から実行できる。

```ts
import { checkConformance, checkModel, checkTrace } from "./src/index.js";
import { counterModel, createCounter } from "./examples/durable-counter.js";

const result = await checkConformance(counterModel, createCounter(), [
  { type: "add", id: "request-1", amount: 2 },
  { type: "crash" },
  { type: "restart" },
  { type: "add", id: "request-1", amount: 2 },
]);
if (result.status !== "matched") throw new Error(JSON.stringify(result));

const oracle = checkModel(counterModel, { maxDepth: 4, maxStates: 500 });
for (const trace of oracle.traces) {
  const replay = await checkTrace(trace, createCounter());
  if (replay.status !== "matched") throw new Error(JSON.stringify(replay));
}
```

例は独立した immutable な参照モデルと mutable な実装で構成する。障害は `crash` / `restart`、ネットワークは `send` / `deliver` / `drop` の操作として明示する。配信インデックスを選ぶことで遅延・並べ替えを再現する。OS の実際の通信やディスク障害を注入する機能は含まない。

`Model.initial()` と `Model.step()` は許容する状態と観測の候補を返す。`Driver.reset()` と `Driver.step()` は実装を操作して観測を返す。非決定的なモデルでは、観測に合う候補状態を履歴全体で絞る。ドライバーの例外は呼び出し元に伝わり、`dispose()` は終了時に呼ばれる。

## Property-based testing と差分テスト

```ts
import assert from "node:assert/strict";
import { array, constantFrom } from "fast-check";
import { checkProperty } from "./src/property.js";
import { checkDifferential } from "./src/index.js";
import {
  counterModel,
  createCounter,
  type CounterAction,
} from "./examples/durable-counter.js";

const actions = array(
  constantFrom<CounterAction>(
    { type: "add", id: "a", amount: 1 },
    { type: "crash" },
    { type: "restart" },
  ),
  { maxLength: 24 },
);

const result = await checkProperty(counterModel, createCounter, actions, {
  seed: 42,
  numRuns: 100,
});
assert.equal(result.status, "passed");

const diff = await checkDifferential(createCounter(), createCounter(), [
  { type: "add", id: "a", amount: 1 },
]);
assert.equal(diff.status, "matched");
```

このコードは Vitest の `test()` 内でも `node:test` 内でも動く。`persist: false` の故障実装では、反例が `add → crash → restart` に縮小する。結果の `seed` と `path` を同じ arbitrary・fast-check バージョンとともに渡すと再実行できる。長期保存には操作列自体も残す。無効操作で全件が棄却される場合は `exhausted` になる。

デモは `.artifacts/oracle.json`、`tla-oracle.json`、`counterexample.json` を生成する。`decodeTrace` は action / observation の型ガードを要求する。トレースはバージョン付き JSON で、bigint・Set・Map はアダプターで明示的に符号化する。

## アダプターと移植性

| import            | 役割                                                   | ランタイム                     |
| ----------------- | ------------------------------------------------------ | ------------------------------ |
| `src/index.ts`    | 有限モデルの BFS、合成、適合性比較、差分比較、トレース | 外部依存のない TS              |
| `src/property.ts` | 生成、縮小、seed/path 再現                             | fast-check                     |
| `src/tla.ts`      | 実際の TLA+ 検査結果と有限反例の変換                   | tla-ts                         |
| `src/smt.ts`      | SMT-LIB の SAT/UNSAT/UNKNOWN と整数解の取り出し        | 呼び出し側で初期化した Z3 Wasm |

コアを import してもソルバーは読み込まれない。Chromium の E2E は4つの経路を実行する。Z3 のブラウザ実行には `z3-built.js` / `.wasm` の配信、SharedArrayBuffer、COOP/COEP ヘッダーが必要。

`tla-ts@0.0.10` は Node/Bun 向け参照を含むため、ブラウザで通常の import をそのままバンドルすると失敗する。この試作では esbuild の `alias: { "node:zlib": "fflate" }`、`external: ["bun:jsc"]`、`define: { global: "globalThis" }` を使う。Bun 専用の動的 import はブラウザでは到達しない。TLA+ は既定の単一ワーカーで検査する。具体的な配信とビルドは [ブラウザテスト](tests/browser.spec.ts) を参照。

Z3 は `init()` の結果を `createSmtOracle(api)` に渡す。Node では利用後に `killThreads(api.em)` を呼ぶ。整数解を十進文字列で返し、無制限整数の精度を保つ。SMT-LIB の assertion を渡す API であり、任意の TS 関数を自動で記号実行する機能はない。

## 検証の範囲

- モデル検査の `complete` は、提供された `actions` と衝突のない `key` に対して到達グラフが閉じたことを表す。打ち切りは `bounded`、初期状態なしは `empty`。TS コアの検査対象は状態不変条件で、liveness / fairness は含まない。
- 生成トレースは到達状態・遷移の代表的な witness。実装の全履歴を網羅するテスト集合ではない。モデル側の状態が同じでも、実装には異なる隠れた状態があり得る。
- 適合性比較は指定した操作列・観測・抽象化に対する検査。`invalid` はモデルで実行できない操作、`mismatch` は許容観測からの逸脱。汎用の refinement proof や線形化可能性の証明ではない。
- `composeModels` は独立操作の interleaving と明示した `both` 操作の直積を探索する。モデル間の境界不変条件を指定できる。assume-guarantee 推論は行わない。
- TLA+ アダプターは成功時に witness を捏造しない。lasso の反例は有限オラクルへ変換せず、元の検査結果を残す。型や整数意味論を Z3 と自動で一致させる変換は含まない。

[設計](docs/architecture.md)、[テスト手法の調査](docs/testing-research.md)、[検証記録](docs/validation.md) を参照。
