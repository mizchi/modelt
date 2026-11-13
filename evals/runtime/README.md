# 時間予算・Rust・クラウド分割の評価

```sh
rustup target add wasm32-unknown-unknown
just runtime-build
just runtime-test
pnpm runtime:eval .artifacts/my-runtime-run
```

Rust は依存 crate のない実験用カーネル。通常の TS ライブラリ利用には Rust のインストールは不要。Rust / Wasm の比較とブラウザ実行は追加のコマンドで検証する。

## バジェットから並列度と深さを選ぶ

`src/budget.ts` は pure TS。`durationMs`、`memoryBytes`、`maxWorkers`、`maxDepth`、`branching` と workload に対応する実測 profile を受け取る。起動時間を差し引いた容量とメモリの概算から、探索できる木の深さと状態数を選ぶ。profile がない場合は `uncalibrated`、初期状態の費用も賄えない場合は `insufficient-budget`。

profile の `visitsPerMs` の単位を混ぜない。カーネルは遷移/ms。非同期実装では正常版と故障版を実行する1 schedule を1 visitとして測り、prefix の数を全部 schedule 相当で課金する保守的な上界を使った。実際の SUT、ソルバー、モデルの違いごとに calibration が必要。

`fixedMemoryBytes` は今回 RSS snapshot、`bytesPerState` は探索表現による見積りで、OS の強制メモリ上限ではない。`startupMs = 0` の再利用 profile は既に起動している pool のみを表す。新しい pool を作るときに再利用 profile を流用しない。

検査 worker 数と SUT の同時操作数は別。`scheduler.ts` は2/3同時操作の read/write 順序を制御し、深さ・ノード数・dispatch 時の soft deadline で検査範囲を制限する。進行中の job を強制終了しないため、予算超過はあり得る。Node 本体・CI runner・ネットワークの起動はセッションの外で、必要なら caller の profile に別途含める。

結果の `coverageComplete: false`、`budget-exhausted` を安全性の証明へ読み替えない。見つかった反例は、探索が部分的でも反例として有効。

## 比較の範囲

`table.ts` は counterModel の有限グラフを CSR 形式（offset / action ID / target ID）へ変換する。初期状態・有効操作・successor が一意な場合の walk を扱い、動的 TS と同じ操作列を生成する。

1. 動的 TS: 元の transition と状態 key を評価。
2. 表形式 TS: 同じグラフの配列を走査。
3. Rust native / Wasm: 同じ配列・PRNG・予算・checksum を使う。

seed 61〜100の trace を照合し、故障版・正常版を元の TS モデルで比較する。Rust は TLA+ パーサー、任意の TS 関数、Z3 全体の移植ではない。表の構築費用と、JS/Wasm 境界で trace を取り出す費用も別に記録する。Wasm の返す trace 領域は次の実行で無効になるため、TS adapter は直ちにコピーする。

## Sharding CLI

```sh
pnpm eval:shard prepare .artifacts/cloud/manifest.json
pnpm eval:shard run .artifacts/cloud/manifest.json 0 4 .artifacts/cloud/shard-0 1 5000
pnpm eval:shard run .artifacts/cloud/manifest.json 1 4 .artifacts/cloud/shard-1 1 5000
pnpm eval:shard run .artifacts/cloud/manifest.json 2 4 .artifacts/cloud/shard-2 1 5000
pnpm eval:shard run .artifacts/cloud/manifest.json 3 4 .artifacts/cloud/shard-3 1 5000
pnpm eval:shard merge-directory .artifacts/cloud/manifest.json .artifacts/cloud/merged.json .artifacts/cloud
```

各 `run` は独立したホストで実行できる。引数は manifest / shard index / shard count / 出力先 / worker 数 / soft budget ms。worker 数はホストの calibration から planner が選んだ値を渡せる。クラウドのインスタンス数と、インスタンス内の worker 数は別に上限を設ける。

manifest は source version と入力から task ID を計算し、入力の並び順が変わっても同じ ID を作る。index は0始まり。shard 数を変えて再配置しても task ID は変えない。

集約では欠落を `partial`、異なる manifest / source / 同じ task の異なる結果を `conflict` とする。同じ結果の再試行は重複排除し、失敗後に正常な結果が届いた task は回復できる。未解決の task が残れば完了しない。`complete` は manifest の全 task の完了であり、モデルの安全性を主張する値ではない。

準備した manifest は40 seed のカーネル検査、2同時操作の6順序、3同時操作の90順序を含む。汎用の TS クロージャを JSON 化して送る仕組みではなく、version 管理した task handler を同じコードで配布する。クラウドの runner が失われた場合も、残りの task ID を再配布できる。

[GitHub Actions](../../.github/workflows/sharding.yml) は prepare → 4 shard → merge を別 runner で実行する。`fail-fast: false`、失敗時の artifact 保存、欠落した結果を完了にしない集約を含む。他のクラウドでは同じ manifest / reports のファイル契約を S3 等へ載せられる。
