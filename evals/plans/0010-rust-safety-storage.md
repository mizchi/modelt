# Rust safety の状態保持と literal 評価

0009 の初回測定は ring10万状態で tla-ts 28.67ms、Rust native process 29.45ms、Wasm 29.88ms。grid100では4.51msに対して6.72ms / 5.93msだった。Rust 化だけでは大きいモデルの改善を確認できなかった。

候補は、毎 successor の state vector、visited の key、各 node の action string、current / next scratch の確保と、literal の文字列から整数への反復変換。baseline を再生して保存した後に native を profile する。検出した費用に応じて、state の連続格納、親・action index、scratch 再利用、literal の一度だけの decode を検討する。

hash だけの状態同一視には変えない。hash collision の場合も完全な state 比較を要求する。公開 IR と型・overflow・deadlock・予算・反例の意味を保ち、同じ差分 corpus と TLC 対照を再実行する。

比較は0009と同じ6入力・warmup2・測定7・交互順。同じホストで、tla-ts end-to-end、frontend、native process 全体、Wasm requestを再測定する。0009 の run は編集せず、別 run に source・入力・全 sample と判断を残す。タイミングを見て case を選び直さない。言語差と格納・式表現の変更を混同しない。
