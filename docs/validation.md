# 検証記録

実行日: 2026-11-14。ローカルは macOS、Node.js 24.22.2、pnpm 10.12.1。依存は lockfile に固定している。

| コマンド                         | 結果                                                    |
| -------------------------------- | ------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | 成功                                                    |
| `just check`                     | Biome、TypeScript、Vitest 31件、node:test 31件が成功    |
| `just browser`                   | Chromium の実ブラウザで1件成功                          |
| `just demo`                      | witness の生成・再生、故障検出、TLA+ と Z3 の実行が成功 |
| `just mutation`                  | mutator 0.2.0 / Vitest 5.1.0 で完了                     |

ブラウザテストは Node の vm による代替ではなく、Playwright で起動した Chromium で実行する。コア単独のバンドルに外部依存が入らないことも確認する。COOP/COEP を付けた localhost から実際の Z3 `.wasm` と worker 用 JS を配信する。

## 再現した故障

永続化を行わない実装に対して、fast-check 4.10.2、seed `42`、path `11:1:7:6` で次の反例を生成した。

```json
[
  { "type": "add", "id": "a", "amount": 1 },
  { "type": "crash" },
  { "type": "restart" }
]
```

再起動後の期待値は1、実測値は0。再現には `examples/demo.ts` と同じ arbitrary を使う。PBT のテストは seed/path の再実行結果も照合する。

重複検査を省いた実装では、同じ ID の加算を2回実行すると期待値1に対して実測値2になり、差分テストでも検出する。モデル探索のデモは深さ4・最大500状態の条件で52状態、288遷移を探索し、初期状態を含む289 witness を正常実装で再生した。結果は `bounded` である。

TLA+ は実際の `tla-ts@0.0.10` で値が2に達する不変条件違反を検出し、2操作の有限オラクルへ変換する。Z3 は `z3-solver@5.4.1` の Wasm で SMT-LIB を解き、整数解7を取得する。成功・反例なしの TLA+ 検査と、UNSAT の SMT 制約もテストする。

## Mutation testing

`mutator.config.json` は比較処理と例の実装を対象にする。モデル側の遷移を同時に変異させず、オラクルの独立性を保つ。

| 対象                          | Killed | Survived | CompileError | NoCoverage |
| ----------------------------- | -----: | -------: | -----------: | ---------: |
| `src/conformance.ts`          |     41 |        0 |           45 |          0 |
| `examples/durable-counter.ts` |     63 |        5 |           84 |          0 |
| 合計                          |    104 |        5 |          129 |          0 |

生成した238変異のうち、129は型検査で棄却された。実行可能な109変異に対する検出率は約95.4%。CompileError をテストによる検出に加算していない。任意のスコアを CI の合否条件には設定していない。

生存した5変異の解釈:

- 初期 `running = true` の反転: Driver 契約では最初に必ず `reset()` が代入する。
- 観測の `running ? value : 0` の条件を true にする変更: 停止した到達状態では `value` 自体が0。
- crash の `seen.clear()` の削除: 停止中は加算されず、再起動時には永続化した集合で置き換える。
- action の `typeof amount === "number"` の削除: 後続の `Number.isSafeInteger` が他の型を拒否する。
- observation の `typeof value === "number"` の削除: 同じく後続の `Number.isSafeInteger` が拒否する。

この評価は型ガードと比較・再生処理、例の実装に限る。探索器、モデル合成、PBT ラッパー、TLA+ / SMT アダプターの全 mutation 評価ではない。node:test 自体を変異させるアダプターも実装していない。

詳細レポートは `.mutator/report/mutation.json`。GitHub Actions でもレポートを artifact として保存する。上記の数字はこの実行時点の記録で、将来の変更で自動的に保証される値ではない。
