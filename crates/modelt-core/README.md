# modelt-core

Rust native / Wasm core for finite state models, conformance checking, trace replay, and failure-preserving sequence shrinking.

`Session::new()` and `Session::replay()` return effects. The caller performs model evaluation or I/O and returns responses with the pending effect ID. `FiniteModel` loads a versioned, observation-bearing transition table without a model-language runtime. `FiniteModel::check_history()` validates saved observations against that table. No threads, clocks or host imports are required by the Wasm library.

See the [repository](https://github.com/mizchi/modelt) for TypeScript bindings, the shared value format, examples, and evaluations. The `modelt-core` binary accepts the same versioned JSON commands over stdin/stdout, one JSON object per line.

The release is experimental. A matched finite history covers the supplied actions and observations; it is not a refinement proof or a liveness guarantee.
