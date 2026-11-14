# TLC を直接オラクルにする差分検査

既存 scalar32入力、複合値・temporal46入力を現在版で再実行する。その後、期待判定を Rust から作らず、同じ TLA+ source / config を TLC・Rust native・Wasm に渡す差分ハーネスを追加する。正常・違反・empty・model error と、compiler の未対応・予算切れ・実行基盤の失敗を分ける。

境界値は空区間と型の異なる所属、SubSeq の範囲と空列、集合の部分集合・比較の短絡、空 domain / domain 不一致時の関数・record の所属、Seq を含む range、EXCEPT の未存在 path、文字列の Len / Tail / 連結 / SubSeq を固定する。文字列は portable value の Unicode scalar 範囲を前提にし、surrogate pair を分割する結果は今回の対応範囲に含めない。

状態数2〜4の有限遷移モデルを seed 0x15A1 で32個生成する。初期状態の個数、遷移、state property / eventually / always-eventually / eventually-always / leads-to と論理結合、WF / SF を変える。開発ケースが一致した後、未使用の確認 seed 0x15B2 の32個を実行する。確認結果を見た修正が必要なら、その run を保ち、新しい確認条件を先に登録する。

native と Wasm は結果・trace・work を完全比較する。TLC とは API 名の差を正規化した判定、complete / empty の状態数・生成数を比較する。有限な小グラフでは liveness 判定時の数も照合する。反例は TLC に強制再生し、全 state の到達・元の遷移・fairness と違反を確認する。有限反例の長さも照合する。TLC の構文・設定・JVM エラーをモデル評価エラーとして合格させない。明示的なエラー対照を残し、error 一致数を complete 数へ加えない。

差分は打ち切らず入力・両結果・生ログ・分類を保存し、mismatch / incomplete / infrastructure-error を結果に残す。TLC と source / Wasm / native binary の digest、revision、seed と toolchain を固定する。最初の mismatch は Red として保存し、TLC ソースと実行で原因を確認してから修正する。修正後も旧 run を変更しない。CI は新しい境界ケースと native / Wasm / tla-ts の回帰検査を行い、TLC の手動 run / replay も justfile に登録する。全 TLA+ 互換や未知の実システムのバグ検出とは扱わない。

開発 run の補足: TLC v1.7.4 (`5a47802b5c391f59ecdd44117981f4ff8c0656ba`) の SANY は非BMP文字を含む2つの入力を字句エラーで拒否した。原入力は残し、同じ2入力を明示的な拒否対照にする。Rust frontend も拒否することを検査し、モデルの一致件数には加えない。初期 invariant violation では集計数を出さないため、出力のある数だけ照合し、欠測を0と解釈しない。TLC master と v1.7.4 は String の Head / Append / toTuple の扱いが違うため、jar と同じ tag のソースで修正する。確認 seed は未実行のまま維持する。

初回の確認 seed 0x15B2 は32件一致した。保存結果の replay では、未実行の native 欄を `undefined` 付きで返すと JSON 保存時に欄が消え、比較が失敗する問題を2件の抜粋で再現した。未実行欄を省略する修正だけを行う。モデル検査器・入力の意味・binary は変更しない。元の確認結果を残し、追加確認 seed 0x15C3 をここで予約する。追加確認を従来32件の新しい独立実行として水増ししない。
