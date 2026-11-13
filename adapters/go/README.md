# modelt Go adapter

Go 1.25+。同じ Rust/Wasm コアを wazero v1.12.0 で実行する。CGO、Node、Rust のインストールは実行時には不要。利用者が ABI v1 の `modelt-core.wasm` を渡す。

module は `github.com/mizchi/modelt/adapters/go`、package は `modelt`。registry 用の version tag は未作成。リポジトリでは `just go-test` でビルドと相互運用を検証する。

モデル callback と Go の実装を接続する `Core.Check`、有限モデルから実行する `Core.CheckFinite`、保存オラクルの `Core.Replay`、実行履歴 batch の `Core.CheckHistories` を提供する。縮小候補の取得と HostTape の再検証もできる。

[利用例と制約](../../docs/go-adapter.md) を参照。Go の SUT を操作する `Driver` は呼び出し元が実装する。goroutine の scheduling、BFS、PBT、OS 障害注入は含まない。
