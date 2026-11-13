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
- Rust 実験を変更したら `just runtime-build` / `just runtime-test` と cargo fmt を確認する。言語差と表現の最適化、cold start と再利用、カーネルと SUT/オラクルの費用を分ける。
- sharding は manifest / source version / task ID を固定し、欠落・再試行・異なる結果を区別する。輸送上の全 task 完了を、モデルの安全性や完全探索の証明として扱わない。
- コミットは conventional commits。公開やリリースは依頼の範囲に従う。
- 有限モデル・縮小・ホストの変更は `just usable-test` と `just usable-eval` / `just usable-replay` で検査する。archive と vendor の原本を編集せず、registry 初回公開やアカウント設定は別途扱う。配布変更は `just package` の単独 consumer まで確認する。
- portable core を変更したら `just portable-build` / `just portable-test`、crate の cargo fmt / clippy を実行する。値・protocol の互換性は共有 fixture と既存 TS checker への差分比較で検査し、BFS や PBT まで移植済みと解釈しない。
- Go adapter は `adapters/go` の独立 module。変更時は `just go-test` で CGO 無効・race・vet・TS fixture・別 module の consumer を検査する。照合の意味論は Wasm コアに任せる。
- 3言語の実 SUT と共通 oracle の比較は `just cross-test`。実験時は `cross-eval` / `cross-replay` で保存したモデル・oracle・反例を使い、SUT の観測を期待値へ転用しない。
