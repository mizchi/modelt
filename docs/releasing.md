# 配布と公開

バージョンは npm / Cargo とも `0.1.0-alpha.0`。registry への公開はまだ行っていない。

```sh
just package
```

`.artifacts/packages/` に npm `.tgz`、Cargo `.crate`、standalone Wasm、Wasm の SHA256/ABI manifest を作る。package-test は一時的な別 consumer に archive を導入し、ソルバーを入れない TS/Wasm、CLI の終了コード0/1/2、Cargo の offline build/run を検査する。consumer-result.json に結果を残す。

npm の files はライブラリ、CLI、Wasm、docs に限定する。eval の原本・run・test や開発用 binary を同梱しない。`fast-check`、`tla-ts`、`z3-solver`、`fflate` は optional peer dependency。コアの導入には不要で、使用する adapter に応じて導入する。

## 初回の registry 登録

初回 npm publish と Trusted Publisher の登録はアカウント所有者が行う。pack と consumer 検証を済ませてから実行する。

```sh
npm login --auth-type=web
npm publish .artifacts/packages/mizchi-modelt-0.1.0-alpha.0.tgz --access public --tag next
npm trust github @mizchi/modelt --repo mizchi/modelt --file release.yml --allow-publish -y
npm trust list @mizchi/modelt
```

`npm trust` は npm 11.15+ と2FAが必要。公開と OIDC の仕組みは [npm の公式説明](https://docs.npmjs.com/trusted-publishers/) を参照。`v*` タグの保護は repo 管理者が ruleset で設定する。設定変更と初回 registry 書き込みは今回自動実行していない。

Cargo の初回公開はアカウントと crate 名の確認後に行う。

```sh
cargo login
cargo publish --locked --manifest-path crates/modelt-core/Cargo.toml
```

この手順は crate registry への公開を行う。Cargo の自動公開は未設定で、GitHub Release に `.crate` を添付する構成。

## 次回以降

package.json / Cargo.toml の version を同じ新しい値にし、Cargo.lock と CHANGELOG を更新してチェックを通す。初回に `0.1.0-alpha.0` を公開した後は、同じ version のタグで再 publish しない。次の `0.1.0-alpha.1` 等へ上げる。

`v<version>` の push は release.yml を起動する。tag / npm / Cargo の version 一致、型・テスト、pack、単独 consumer、ブラウザを検査してから OIDC で npm publish し、Wasm と archives を GitHub Release へ添付する。pre-release は next、安定版は latest。NPM_TOKEN は使わない。

registry へ公開済みの version は使い回さない。途中まで公開して失敗した場合は状態を確認し、次の version で再リリースする。

## CI の分割粒度

PR は1ジョブで TS / Rust / ブラウザ / mutation / 実バグ評価 / consumer を順に検証する。push の自動実行は main に限り、PR branch の push と pull_request の二重起動を避ける。

4800件の portable 評価、runtime 性能評価、4 runner の cloud sharding はそれぞれ workflow_dispatch で残す。重い評価を明示的に実行でき、sharding の manifest / 欠落・衝突検出も保持する。PR で runner を prepare → shard → merge と3段階待つ構造を外した。GitHub の割当待ちそのものを短縮する保証ではない。
