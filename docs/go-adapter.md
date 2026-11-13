# Go からモデルと実装を照合する

`adapters/go` は Go 1.25+ の独立 module。Rust の共通 Wasm コアを [wazero](https://wazero.io/) で実行する。実行時に CGO、Node、Rust、外部プロセスを必要としない。Wasm は自動取得せず、呼び出し元が読み込み・配布する。

```sh
just go-test
```

Wasm の build、TS の相互運用 fixture 生成、CGO 無効の Go tests、race、vet、別 module の consumer を実行する。Go module の取得には最初だけ依存の download が必要。既存プロジェクトからは module path `github.com/mizchi/modelt/adapters/go` を使う。version tag は未作成なので、依存は commit に固定するか `replace` で checkout を参照する。

## 有限モデルを渡す

TS で有限グラフが閉じた場合だけ artifact を作る。この例をプロジェクト内で実行し、`toggle.json` と `just portable-build` で得た `modelt-core.wasm` を Go アプリへ渡す。

```ts
import { writeFile } from "node:fs/promises";
import { compileFiniteModel } from "@mizchi/modelt/finite";

const result = compileFiniteModel<boolean, string, boolean>(
  {
    name: "toggle",
    initial: () => [{ state: false, observation: false }],
    actions: () => ["toggle"],
    step: (state, action) =>
      action === "toggle" ? [{ state: !state, observation: !state }] : [],
    key: String,
  },
  { maxDepth: 2, maxStates: 2 },
);
if (!result.model) throw new Error(result.status);
await writeFile("toggle.json", JSON.stringify(result.model));
```

Go 側は実装への操作と観測を `Driver` に置く。モデルの遷移ロジックを実装のために呼ばない。

```go
package main

import (
    "context"
    _ "embed"
    "fmt"
    modelt "github.com/mizchi/modelt/adapters/go"
)

//go:embed modelt-core.wasm
var wasm []byte

//go:embed toggle.json
var model []byte

func main() {
    ctx := context.Background()
    core, err := modelt.New(ctx, wasm)
    if err != nil { panic(err) }
    defer core.Close(ctx)

    enabled := false
    driver := modelt.Driver{
        Reset: func(context.Context) (modelt.Value, error) {
            enabled = false
            return modelt.ValueOf(enabled)
        },
        Step: func(context.Context, modelt.Value) (modelt.Value, error) {
            enabled = !enabled
            return modelt.ValueOf(enabled)
        },
    }
    toggle, err := modelt.ValueOf("toggle")
    if err != nil { panic(err) }
    result, err := core.CheckFinite(ctx, model, driver, []modelt.Value{toggle, toggle})
    if err != nil { panic(err) }
    if result.Status != "matched" { panic(result.Status) }
    fmt.Println(result.Status)
}
```

有限モデルには TS 関数や property の式を格納しない。観測・遷移・不変条件違反のラベルを格納する。グラフが閉じていることと、全性質が安全であることは区別する。

## API と所有権

| API                                            | 用途                                 |
| ---------------------------------------------- | ------------------------------------ |
| `Check(ctx, Model, Driver, actions)`           | Go のモデル callback と実装を照合    |
| `CheckFinite(ctx, modelJSON, Driver, actions)` | 共通有限モデルを使い Go の実装を照合 |
| `Replay(ctx, Trace, Driver)`                   | 保存オラクルに対して実装を実行       |
| `CheckHistories(ctx, modelJSON, traces)`       | 実観測の履歴 batch をモデルと照合    |
| `Canonicalize(ctx, Value)`                     | 共通の値の検証・正規化               |
| `DeletionCandidates(ctx, length)`              | 反例を削除して縮める候補を列挙       |
| `ReplayHost(ctx, tapeJSON)`                    | HostTape の操作・結果を再検証        |

`Model.Initial` は `[]Transition`、`Model.Step` は候補 `[]State` と操作を受け、`[]Transition` を返す。候補は履歴の観測で絞り込まれる。`State.Key` は将来の振る舞いを識別できる値にする。観測と callback の引数は immutable な snapshot として扱う。

`Result.Status` は `matched`、`mismatch`、`invalid`。実行不能な操作では `Driver.Step` を呼ばず `invalid` にする。空の初期候補でも `Driver.Reset` の観測を記録して `invalid` にする。`CheckHistories` は SUT を実行しないので、実装で反例を再現するには `Replay` または `CheckFinite` を使う。

`Value` は `json.RawMessage` の alias で、tagged JSON を保持する。`ValueOf` は整数・bool・Unicode string・bytes・list・string-keyed map を変換する。整数は十進文字列で保存し、Go の整数精度を保つ。float と struct の暗黙変換は拒否する。set / map は [portable value の wire format](portable-core.md#値とトレース) で渡し、共通コアで正規化する。生の JSON を通常の `map[string]any` に decode して Go の float64 へ落とさない。

`Driver.Dispose` は optional。受け付けた照合ごとに成功・error・panic を含め1回実行する。error または panic 時は pending session を cancel し、panic は呼び出し元へ伝える。cleanup には cancellation を外した context を渡し、複数の error は `errors.Join` で保持する。callback は渡された context を尊重する必要があり、SDK は callback の goroutine を強制停止しない。Wasm 呼び出し中の cancel は instance を閉じるため、その場合は新しい Core を作る。

1つの Core は1操作を実行する。並行・再入は `ErrBusy`、閉じた instance は error を返す。worker ごとに Core を作り、終了時に `Close` する。自動の timeout は設定しない。

Go への BFS / PBT の移植、goroutine scheduler、Go の記録ホスト、OS 障害注入は含まない。縮小候補は候補の列挙までで、失敗の同一性を保つ縮小ループは呼び出し元が持つ。
