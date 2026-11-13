# 評価しながら改善する

モデル検査・テスト手法の採用判断を記録する場所。仮説、条件、実行、判断、次の仮説を1つの iteration として残す。比較器の `improved` は故障ごとの検出数の増加を表し、費用や外的妥当性を含む採用決定ではない。

```sh
just eval-loop
just replay-loop
```

`eval-loop` は既定の plan で開発用・確認用 seed を実行し、新しい run ID を作る。`replay-loop` は台帳で最新の完了した確認 run を選び、故障版で失敗・正常版で通過することを検査する。

plan と run ID を明示する場合:

```sh
pnpm eval:loop evals/plans/0001-longer-walk.json my-run
pnpm eval:replay evals/runs/my-run-confirmation
```

| 場所                       | 記録するもの                                                       |
| -------------------------- | ------------------------------------------------------------------ |
| `methods.md`               | 手法の定義、比較単位、前提、解釈の制約                             |
| `plans/`                   | 結果を見る前に固定する仮説、変更点、予算、seed、判断の観点         |
| `runs/<id>/manifest.json`  | plan、ソースの SHA-256、revision、dirty paths、実行環境、親 run    |
| `runs/<id>/trials.json`    | 正常版と全故障の seed ごとの検出・見逃し・コスト・再現結果         |
| `runs/<id>/corpora.json`   | 生成ケース数、状態・遷移、生成時間、要求操作数                     |
| `runs/<id>/witnesses.json` | 故障版を元のモデルで検査し直す操作列                               |
| `runs/<id>/result.json`    | 集計、正常対照、評価、各証拠の digest。完了の目印                  |
| `runs/ledger.jsonl`        | run の追記台帳。例外は `error`、正常対照の失敗は `controls-failed` |
| `iterations/`              | 結果の解釈、採用・保留の理由、後退、次の仮説                       |
| `harness/`                 | 実験用のモデル・実装・探索器。public API と分離                    |

## ループの進め方

1. 前の iteration の見逃し・費用・調査の難しさから、変更点を1つ選ぶ。
2. plan を作り、結果を見る前にコミットする。モデル、正常版、故障集合、予算、開発用・確認用 seed を明示する。
3. 実装とテストを整え、開発実行を記録する。
4. 同じ plan / ソースのまま確認用 seed で実行する。途中の変更、重複 seed、変更された証拠を拒否する。
5. 数値だけでなく witness を再現する。正常版の誤検出、無効操作、再現失敗は判断の前提を崩す。
6. iteration に判断を追記する。後退がある場合も保存し、次の仮説へ進む。

既存 run ID は上書きできない。中断や例外で `result.json` がない run を合格として扱わない。結果・台帳を編集して再試行を隠さず、新しい ID で実行する。formatter の対象から `runs/` を除外し、元の証拠を保つ。

確認用 seed も同じ人工故障集合を使う。これはスケジュールに対する確認であり、未知故障や実システムへの一般化を検証したことにはならない。確認結果を見て次の仮説を作る場合は、別の確認用 seed を予約する。

実行済みの比較は [0001: 履歴長16](iterations/0001-longer-walk.md)、[0002: 8/16の混在](iterations/0002-mixed-depth.md)。次の仮説は [backlog](backlog.md) に残す。CI で同じ plan を反復するのは再現・回帰確認であり、新しい独立した確認実験として集計しない。

初回の幅広い pilot は `pnpm evaluate` / `pnpm evaluate:replay` で再実行できる。履歴は [0000](iterations/0000-pilot.md)。古い記録には後付けの厳密な provenance を主張せず、`legacy-import` として区別した。
