# 複合値と temporal 検査

残っていた state の有限集合・関数・record・sequence、有限量化、SPECIFICATION / PROPERTY、weak / strong fairness を Rust backend へ追加する。型付き値を intern し、既存の scalar state は Copy のまま保持する。tuple / record と有限関数の TLA+ における等価性、EXCEPT の @、1始まりの sequence、集合の正規化を TLC ソースと実行で確認する。

temporal property は state/action predicate、論理結合、always / eventually / leads-to を扱い、否定した property と fairness の積を generalized Büchi automaton と有限グラフの SCC で検査する。stuttering、WF と SF の違い、複数の eventuality、終端状態、複数初期状態を対照にする。bounded / empty / 例外を complete にしない。探索と temporal 処理で work 予算を共有し、product の上限も明示する。lasso は loopStart と最後の遷移を保存する。

TDD で正常・故障・不正入力を追加し、Rust native / Wasm / tla-ts / TLC と比較する。最短 safety trace と liveness の lasso を区別する。TLC で返却 lasso を強制再生して、モデルの遷移と fairness を満たした違反であることを検査する。集合・関数・sequence を使う既存 TLA+ Example も原文・revision・license 付きで追加する。

性能はソースを固定してから測る。以前と同じ6 scalar 入力、有限集合の配送、function のノード状態、sequence の queue、fairness 付き有限モデルを含める。warmup2・測定7・順序交互、frontend / native process / Wasm request・startup を分ける。scalar の速度維持と、複合値・temporal の費用を別に解釈する。状態数・生成数、反例・正常対照を確認した後に採用を判断する。

run は排他的に作り、source / 入力 / 結果 / 生サンプル / 反例 / TLC log / toolchain と digest を保存する。原本・過去 run を編集しない。未対応の無限集合・高階 operator・module system・temporal quantification の範囲を明記し、全 TLA+ 互換へ一般化しない。
