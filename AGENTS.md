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
- コミットは conventional commits。公開やリリースは依頼の範囲に従う。
