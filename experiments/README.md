# 手法の評価

ライブラリへ昇格させる前に、追加の故障検出・反例の説明力・実行コストを測るための実験。ここにある探索器・時刻注入・並行履歴 checker は package の public API ではない。

```sh
just evaluate
just replay-evaluation
```

`.artifacts/evaluation/` に集計 JSON、seed ごとの CSV、再現用 witness を出力する。`evaluate:replay` は保存した操作列を元のモデルへ戻し、故障版の失敗と正常版の通過を確認する。失敗実装の観測値を正解として replay しない。

- `search.ts`: 同一 reset/step 予算での uniform enabled walk と、状態・遷移の新規性を使う corpus の比較。初期状態と有効遷移が一意なモデルに限定する。
- `counter-faults.ts`: 意図的に入れた既知故障。正常実装の対照を同じ条件で実行する。
- `ttl.ts`: 注入した時計を持つ実装と、独立した期限のモデル。
- `scheduled-counter.ts`: 実際の async 関数を fast-check の scheduler で制御する。
- `history.ts`: 完了した操作の論理的な call/return 順序を入力に、逐次化の存在を bounded search する。予算切れは `inconclusive`。未完了操作、クラッシュをまたぐ履歴、実時刻の不確かさは扱わない。
- `evaluate.ts`: 事前に固定した seed と予算で測定し、正常版・再現対照が崩れた場合は測定を失敗させる。

探索器や checker の正しさと、対象実装の正しさを区別する。checker は小さい加算履歴192通りで別の必要十分条件と照合したが、汎用ライブラリとしての適格性は未評価。

[実験計画](../docs/evaluation-plan.md) と [初回の結果・採用候補](../docs/evaluation-results.md) を参照。
