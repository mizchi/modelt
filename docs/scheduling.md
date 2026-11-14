# 独立した検査を常駐workerへ配る

`@mizchi/modelt/scheduling` は、実測profileと時間・メモリ予算からworker数を選び、独立したtaskを配布する。共通層はNode API、Wasm、TLA parser、solverに依存しない。Nodeやブラウザのworkerを作る処理はadapterに置く。

現在の対象は、複数モデル・定数設定・seed・故障ケースの並列実行。1つのTLAモデルのBFSやtemporal検査は各workerの中で逐次実行する。同じモデルを複数回検査した件数を、追加の状態coverageへ加えない。

## 予算から計画を作る

```ts
import { planSchedule, runSchedule } from "@mizchi/modelt/scheduling";

const plan = planSchedule(
  jobs,
  measuredProfiles,
  {
    durationMs: 5000,
    memoryBytes: 512 * 1024 * 1024,
    maxWorkers: 4,
  },
  {
    policy: "cost",
    batchTargetMs: 4,
    maxBatchSize: 16,
  },
);

if (plan.status === "planned") {
  const run = await runSchedule(plan, executors);
  console.log(run.executionStatus, run.remaining);
}
```

`jobs`は`id`、`estimatedMs`、`memoryBytes`を持つ。idは配布単位の一意な識別子。実際のモデル・入力・探索上限はadapter側でこのidに登録する。既存のsharding manifestのtask IDも使える。

`measuredProfiles`は次の値を持つ。実行環境・backend・workload・配置方式に対応するprofileを渡す。異なる環境の値を自動的に共通化しない。

| 値                 | 意味                                              |
| ------------------ | ------------------------------------------------- |
| `id`               | profileの識別子                                   |
| `workers`          | 校正したworker数                                  |
| `startupMs`        | pool作成と初期登録の推定費用。再利用するpoolでは0 |
| `costScale`        | 各taskの基準費用に掛ける、並列実行時の実測倍率    |
| `fixedMemoryBytes` | pool全体の固定メモリの推定値                      |

plannerは各候補のbatchをworkerへ配置し、全件完了時間を推定する。メモリは`fixedMemoryBytes + workers * 最大taskメモリ`で保守的に計算する。時間・メモリ・worker上限内の候補から、推定完了時間が短いものを選ぶ。profileがなければ`uncalibrated`、全件を推定予算に収められなければ`insufficient-budget`、taskがなければ`empty`を返す。

`policy: "fifo"`は入力順で1 taskずつ送る。`policy: "cost"`は推定費用が長い順に並べ、小taskを目標時間と件数上限の範囲でまとめる。目標時間より長いtaskは単独のbatchとなる。配置は全件完了時間の短縮を目的とし、最初の反例を最短時間で見つける優先順位とは別に評価する。

## adapterの実行契約

各executorは`execute(ids)`で、同じidを持つ`{ id, result }`の配列を返す。workerが空くと次のbatchを受け取る。応答の欠落・重複・別taskの混入を拒否し、そのbatchを完了へ加えない。workerの例外もdispatchログに残し、未完了taskは`remaining`へ返す。自動retryはしない。

`executionStatus: "complete"`は全taskの応答が揃ったという意味。モデルが安全であるという判定ではない。TLA adapterは各resultに`complete`、`bounded`、`empty`、違反、モデル評価エラーを残す。worker故障や不正な応答があれば`partial`となる。呼び出し側で各モデルの結果を確認する。

時間予算は次のbatchを配布する前に確認するsoft budget。進行中のbatchは完了まで実行するため、実時間が予算を超えることがある。`runSchedule`の第3引数で、dispatch開始時点の残り時間を明示できる。省略時は計画の時間予算から推定startup費用を引く。新規poolでは実際のstartup費用を引き、既存poolの再利用ではstartupを0として扱う。探索深さ・状態数・work上限は各taskの入力を維持し、wall timeから黙って変更しない。

メモリも推定値で、OSによる強制上限ではない。未知モデルでは探索上限と値の表現から保守的に見積もり、RSS観測で校正する。テスト対象のSUT内の同時操作数と、検査workerの数は別に管理する。

## TLA adapterの試作を動かす

`evals/parallel-safety/`にNodeとブラウザのadapterを置いた。共通の計画・配布APIだけをpackageの独立entryとして公開し、adapterは評価用の試作として扱う。

- Nodeはworker_threadsごとにWasm instance、または常駐Rust native子プロセスを持つ。nativeのworker数はRust thread数ではなく、子プロセス数を表す。
- ブラウザはWeb Workerごとに独立Wasm instanceを持ち、message passingで通信する。SharedArrayBufferとcross-origin isolationは不要。
- 親でsourceを一度コンパイルし、IRとtaskをworkerのTS層へ初期登録する。親からはtask IDを送る。Rust ABIのprogram handleは追加していないため、各checkではIRのserialize / deserialize費用が残る。
- 結果はキャッシュしない。各taskでモデルを探索する。taskのresultは逐次実行と、判定・計数・反例を含めて比較する。

```sh
just parallel-safety-test
just parallel-safety-eval evals/runs/new-parallel-run
just parallel-safety-replay evals/runs/new-parallel-run evals/runs/new-parallel-replay
```

出力先は新規ディレクトリにする。計画は[0017](../evals/plans/0017-parallel-safety.md)。測定はコンパイル済みIRでのbatch実行時間とpool起動・登録を分け、source解析や親のNodeプロセス起動を測定時間へ含めない。
