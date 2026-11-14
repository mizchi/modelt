# 非同期履歴とモデルの再利用

`@mizchi/modelt/history` は有限モデルに対する非同期履歴の checker と recorder。複数操作の呼び出し・応答を別イベントにし、仕様に合う順序が存在するか調べる。TS は独立実装、Rust native / Wasm と Go は共通 Rust checker を使う。

```ts
import { compileFiniteModel } from "@mizchi/modelt/finite";
import {
  createHistoryRecorder,
  checkConcurrentHistory,
} from "@mizchi/modelt/history";
import { toPortableValue } from "@mizchi/modelt/portable";

const compiled = compileFiniteModel<number, string, number | string>(
  {
    name: "register",
    initial: () => [{ state: 0, observation: 0 }],
    key: String,
    actions: () => ["write", "read"],
    step: (state, action) =>
      action === "write"
        ? [{ state: 1, observation: "ok" }]
        : action === "read"
          ? [{ state, observation: state }]
          : [],
  },
  { maxDepth: 2, maxStates: 2 },
);
if (!compiled.model) throw new Error(compiled.status);

let actual = 0;
const recorder = createHistoryRecorder("register", toPortableValue(actual));
recorder.invoke("write-attempt-1", toPortableValue("write"));
actual = 1; // 実装は反映したが、呼び出し元には応答が届かなかった。
recorder.end("write-attempt-1", "unknown");
recorder.invoke("read-1", toPortableValue("read"));
recorder.returned("read-1", toPortableValue(actual));
const result = checkConcurrentHistory(
  compiled.model,
  recorder.snapshot(),
  1000,
);
if (result.status !== "linearizable") throw new Error(result.status);
```

実際の Driver は実装を呼び、開始前に invoke、応答を観測した位置で returned を記録する。`Driver.step` は逐次実行用のまま。並行処理の schedule と I/O は呼び出し元が所有し、recorder はそれを強制制御しない。

## イベントの意味

wire format は `modelt.concurrent-history` version1、model 名、initial の観測、順序付き events。イベントの順序は単一の観測者・制御された scheduler が得た論理順序。複数ノードの時計を自動で統合する機能はない。

| kind    | 意味                                                          |
| ------- | ------------------------------------------------------------- |
| invoke  | 操作の開始。id は呼び出しごとに一意                           |
| return  | 観測した確定応答。この位置までに作用した                      |
| fail    | 作用しなかったことを確認した失敗                              |
| unknown | 作用したか不明。応答喪失や通信 timeout を自動で fail にしない |
| cancel  | 呼び出し元の待機中断。サーバーの処理中断は保証しない          |

unknown / cancel 後に遅い return / fail が届けば、その実際の位置で確定できる。不確定 marker の二重記録と、確定結果の二重記録は拒否する。操作 id と、action 内の業務上の dedup id は別。retry は新しい操作 id と、同じ業務 id を持てる。

未完了操作は作用した候補と、省略した候補の両方を考慮する。返却された order は1つの許容順序で、omitted はその候補で省略した操作。pending は確定結果を観測していない操作であり、実際の作用有無を断定した値ではない。

`linearizable` は観測履歴に合う順序が存在すること、`not-linearizable` はそのような順序がないこと、`inconclusive` はノード予算切れ、`empty` はイベントなし。進行・可用性・無限の liveness は別の性質として検査する。モデルの不変条件の検査も別に行う。

crash、epoch、時計やネットワークの制約はモデルへ明示する。HostTape があるだけで checker が障害の意味を推測することはない。評価の credit モデルは crash を epoch 変更として記録し、旧 process の未完了操作を復旧後へ移せないようにしている。

## 読み込んだモデルを使う

```ts
import { loadFiniteModel } from "@mizchi/modelt/portable";
// core は caller が読み込んだ Wasm instance。
const loaded = loadFiniteModel(core, compiled.model);
try {
  const result = loaded.checkHistory(recorder.snapshot(), 1000);
  // 同じモデルで checkHistories(traces) / checkConformance(driver, actions) も使える。
} finally {
  loaded.release();
}
```

load 時に検証・索引化し、その instance 内で再利用する。handle は保存・転送する ID ではない。別 worker はモデルを読み込み直す。使用中の解放と、解放済み handle の使用は error。既存の inline model API も維持する。

Rust は `FiniteModel::prepare()` の戻り値に `check_concurrent(history, max_nodes)` / `check_history(trace)` を呼べる。Go は `Core.LoadModel` の戻り値に `CheckHistory` / `CheckHistories` / `Check` を呼び、`Close` する。保存 JSON は `CheckHistoryJSON` に原文を渡すと、Go の通常の JSON decode による未知フィールドの消失や Unicode の置換を避けて Rust 側で検証できる。

Core は自動 timeout を追加しない。Wasm 呼び出し中の Go context cancel は instance を閉じる。実装の操作中断と履歴の cancel marker を区別する。

## 縮小と評価

TS の `shrinkCounterexample` は optional な `isEnabled(actions)` と `dependencies(actions)` を受ける。依存は `{producer, consumer}` の位置で、producer は consumer より前。producer の削除時に consumer も削除する候補を追加し、元の単一削除も残す。preflight で無効な入力を SUT へ渡さず、baseline と最終再現も検証する。minimal は候補と有効性の条件下での単一削除に関する値で、全体最短ではない。

```sh
just async-test
just async-eval development .artifacts/async-dev
just async-eval confirmation .artifacts/async-confirm .artifacts/async-dev
just async-replay .artifacts/async-confirm
```

run directory は新しい名前にする。[0008 の計画](../evals/plans/0008-async-tuning.md) は固定した故障・予算・seed で feedback を比較し、model reload / reuse と trace buffer の費用を別に測る。feedback は実験用の counter の操作関係 coverage で、汎用の happens-before coverage や OS の scheduler ではない。
