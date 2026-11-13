# modelt

ユーザーには日本語で答える。Node.js 24+ と pnpm を使う。

- TDD: 探索 → Red → Green → Refactoring。挙動を検証し、モデルと実装で遷移ロジックを共有しない。
- コントラクトは `src/contracts.ts`。コアは Node API、テストランナー、ソルバーに依存させない。
- 状態と観測は immutable なスナップショット。`Model.key` は遷移に必要な状態を省略しない。
- `complete` / `bounded` / `empty`、`matched` / `mismatch` / `invalid` を区別する。探索や生成が成立していない場合に合格させない。
- TLA+ の意味論は tla-ts / TLC のソースと突き合わせる。互換性や証明範囲を推測で広げない。
- タスクは `justfile`。終了前に `just check` と `just browser`。mutation 対象や共有テストを変えたら `just mutation`。
- `@mizchi/mutator` は Vitest で TS ソースを変異させる。node:test は共通の挙動テストを実行する。
- ブラウザ対応を変更したら Playwright の実ブラウザテストで確認する。
- 手法の採用は既存手法に対する追加検出、正常版の対照、実装での反例再現、実行・診断コストで判断する。試作への実装と採用決定を区別し、人工故障の検出を実プロジェクトの未知バグ発見に数えない。
- 実験は `evals/` に置き、public API と分離する。条件を結果を見る前に固定し、変更した条件を記録する。実験を変更したら `just evaluate` と `just replay-evaluation` を実行し、未検出・例外・予算切れを合格へ置き換えない。
- 改善ループは `evals/README.md` に従う。plan を先に記録し、`just eval-loop` / `just replay-loop` で実行と再現を確認する。run は上書き・編集せず、結果を見た確認用 seed を次の仮説の確認に再利用しない。
- コミットは conventional commits。公開やリリースは依頼の範囲に従う。
