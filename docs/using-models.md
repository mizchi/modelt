# 有限モデル・縮小・ホスト

公開前は `just package` で作った `.tgz` を consumer に `pnpm add /path/to/mizchi-modelt-0.1.0-alpha.0.tgz` で導入する。Node 24+ を使う。コア利用だけならソルバーは不要。PBT は `fast-check`、TLA+ は `tla-ts`、SMT は `z3-solver` を別途導入する。ブラウザの TLA+ 用 alias には `fflate` も必要。

## モデルを artifact にする

```ts
import { writeFile } from "node:fs/promises";
import type { Model } from "@mizchi/modelt";
import { compileFiniteModel } from "@mizchi/modelt/finite";

const model: Model<number, "tick", number> = {
  name: "one-shot",
  initial: () => [{ state: 0, observation: 0 }],
  actions: (state) => (state === 0 ? ["tick"] : []),
  step: (state) => (state === 0 ? [{ state: 1, observation: 1 }] : []),
  key: String,
  invariants: [{ name: "at-most-one", check: (state) => state <= 1 }],
};
const compiled = compileFiniteModel(model, { maxDepth: 4, maxStates: 10 });
if (!compiled.model) throw new Error(compiled.status);
await writeFile("model.json", JSON.stringify(compiled.model));
```

出力は `format: "modelt.finite-model", version: 1`。state key、初期観測、操作・target・観測を持つ edge、不変条件の違反ラベルを保存する。観測は state 固有と仮定しない。重複 key、存在しない target、未知 version をロード時に拒否する。

`compileFiniteModel().status === "complete"` は、列挙した actions に対してグラフが閉じて artifact を作れた意味。不変条件がすべて成立するという意味ではない。深さ・状態数で打ち切ると `bounded`、初期状態なしは `empty` となり、artifact を返さない。actions に列挙しない入力は、この artifact では検査できない。

不変条件の式を翻訳する機能はない。TS で各到達状態を評価した違反ラベルを保存する。artifact の不変条件検査は `checkModel(createFiniteModel(artifact), bounds)` または `modelt model model.json` で行う。これは与えた有限表とラベルに対する検査。

## TS / Rust から同じモデルを使う

```ts
import { readFile } from "node:fs/promises";
import {
  createPortableWasm,
  checkFiniteHistories,
  decodePortableTrace,
} from "@mizchi/modelt/portable";
import { parseFiniteModel } from "@mizchi/modelt/finite";

const core = await createPortableWasm(
  await readFile(new URL(import.meta.resolve("@mizchi/modelt/core.wasm"))),
);
const model = parseFiniteModel(
  JSON.parse(await readFile("model.json", "utf8")),
);
const history = decodePortableTrace(await readFile("history.json", "utf8"));
console.log(checkFiniteHistories(core, model, [history]));
```

`checkFiniteHistories` は実観測の履歴をモデルと照合する。実装を操作するには `checkFiniteConformance` に portable value を受け返す Driver を渡す。モデル遷移は Rust の内部で計算し、JS のモデル関数を呼ばない。複数履歴は1 batch にまとめられる。既存の TS モデルを直接使う `checkPortableConformance` も残る。

Rust は `FiniteModel` を deserialize / normalize し、`check_history(trace)` を呼ぶ。入力・出力は Node CLI と同じ契約で、モデル言語のランタイムを必要としない。raw JSON の接続には `Engine::dispatch(bytes)` を使える。

```sh
modelt check model.json history.json
modelt model model.json
```

終了コードは matched / complete が0、mismatch / violation が1、invalid / bounded / empty が2。schema や I/O の例外も失敗として終了する。

## 反例を縮小する

`shrinkCounterexample(actions, evaluate, { maxChecks })` へ、実装を毎回 reset してモデルと再比較する関数を渡す。evaluate は matched / invalid、または mismatch と failure signature を返す。同じ signature の失敗だけを保持し、最後にも再現を確認する。例外は伝播する。

`candidates: length => coreDeletionCandidates(core, length)` で Rust と同じ削除順序を使える。TS の標準候補と Rust native の `shrink_counterexample` も同じ順序。`minimal` は1要素を削除して同じ失敗を維持できないことだけを表し、最短の全体最適解を保証しない。budget で候補を検査し切れなければ `bounded`。

観測列だけを削除して反例を作らない。縮小するたびに SUT を実行する。別の不具合へ縮まないように signature を定義する。schedule、配信、クラッシュ等も明示的な操作に含め、モデルで無効になる候補は採用しない。

## 時計・通信・永続化を注入する

`createSimulationHost` は論理時計、seed 付き選択、並べ替え・破棄できるメッセージキュー、volatile / durable storage を提供する。I/O の入口をこれらへ委譲する Driver を書く。

```ts
import { createSimulationHost } from "@mizchi/modelt/host";
const host = createSimulationHost({ seed: 3 });
host.write("counter", 1);
host.persist();
host.write("counter", 2);
host.send("a", "b", { request: "x" });
host.advance(10);
host.crash();
host.restart();
console.log(host.read("counter")); // 1
host.finish();
const tape = host.trace();
```

`persist()` は volatile 全体の atomic snapshot。crash は volatile を消し、restart は durable を復元する。時計とネットワークキューは残る。実際のディスク durability のエミュレーションや OS の crash 注入ではない。

`choose(label, choices)`、`deliver(index)`、`drop(index)` の選択を versioned な HostTape に残す。同じプログラムへ `createSimulationHost({ replay: tape })` を注入して再実行し、最後に `finish()` する。異なる入力・出力、未消費のイベント、逸脱後の finish は拒否する。read / now は状態を変えず tape に追加しない。

Rust にも `SimulationHost` があり、同じ tape を `replay_host(tape)` で検査できる。TS/Wasm は `verifyHostTape(core, tape)` を使う。これらは記録したホスト操作の実行を検査するもので、外部 SUT を自動で再実行するものではない。SUT の再現は Driver を通して行う。記録しない OS I/O や乱数は別途制御する必要がある。

## 実証と費用

`just usable-test` は原本の async-mutex の修正前後と、共通モデル・tape の TS/Rust/Wasm 照合を検査する。`just package` の後に `just usable-eval` を実行すると、実バグの corpus、縮小、記録なしの同条件比較、package consumer の結果を新しい run に保存する。再現は `just usable-replay <run-directory>`。

性能比較では TS prepared、TS wire、Wasm wire、常駐 native JSONL を分ける。1/16/64履歴、warmup3 batch・測定9 batchで順序を反転し、すべての結果と反例を照合する。wire は転送・正規化・モデル読込を含み、native の起動は別。処理系全体の利用費用として扱い、実装言語の CPU 速度比にはしない。
