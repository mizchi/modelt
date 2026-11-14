default:
  @just --list

install:
  pnpm install --frozen-lockfile

check:
  pnpm check
  pnpm typecheck
  pnpm test

test:
  pnpm test

mutation:
  pnpm test:mutation

browser: portable-build
  pnpm test:browser

demo:
  pnpm example

evaluate:
  pnpm evaluate

replay-evaluation:
  pnpm evaluate:replay

eval-loop:
  pnpm eval:loop evals/plans/0002-mixed-depth.json

replay-loop:
  pnpm eval:replay

runtime-build:
  pnpm runtime:build

runtime-test:
  pnpm runtime:test
  pnpm runtime:browser

runtime-eval:
  pnpm runtime:eval

portable-build:
  pnpm portable:build

portable-test:
  pnpm portable:test
  pnpm portable:browser

portable-eval:
  pnpm portable:eval

portable-replay run:
  pnpm portable:replay {{quote(run)}}

safety-build: portable-build
  pnpm build

safety-test: safety-build
  node --test dist/evals/rust-safety/contract-test.js dist/evals/collections-temporal/contract-test.js

safety-eval run plan="0013-scalar-comparison": safety-build
  node dist/evals/rust-safety/evaluate.js {{quote(run)}} {{quote(plan)}}

safety-replay run:
  pnpm build
  node dist/evals/rust-safety/replay.js {{quote(run)}}

safety-tlc java jar: safety-build
  node dist/evals/rust-safety/tlc-check.js {{quote(java)}} {{quote(jar)}}

go-test: portable-build
  pnpm build
  node dist/evals/go/prepare.js
  test -z "$(gofmt -l adapters/go)"
  cd adapters/go && go vet ./...
  cd adapters/go && CGO_ENABLED=0 go test -count=1 ./...
  cd adapters/go && go test -race -count=1 ./...
  node dist/scripts/go-consumer.js

cross-build: portable-build
  pnpm build
  cargo build --release --locked --manifest-path evals/shared-oracle-rust/Cargo.toml
  mkdir -p .artifacts/go
  cd adapters/go && CGO_ENABLED=0 go build -o ../../.artifacts/go/counter-replay ./cmd/counter-replay

cross-test: cross-build
  cargo fmt --manifest-path evals/shared-oracle-rust/Cargo.toml -- --check
  cargo clippy --all-targets --locked --manifest-path evals/shared-oracle-rust/Cargo.toml -- -D warnings
  node --test dist/evals/cross-language/contract-test.js

cross-eval phase run parent="": cross-build
  node dist/evals/cross-language/evaluate.js {{quote(phase)}} {{quote(run)}} {{quote(parent)}}

cross-replay run:
  pnpm build
  node dist/evals/cross-language/replay.js {{quote(run)}}

async-build: cross-build
  cd adapters/go && CGO_ENABLED=0 go build -o ../../.artifacts/go/history-check ./cmd/history-check
  cd adapters/go && CGO_ENABLED=0 go build -o ../../.artifacts/go/finite-bench ./cmd/finite-bench

async-test: async-build
  node --test dist/evals/async-tuning/contract-test.js

async-eval phase run parent="": async-build
  node dist/evals/async-tuning/evaluate.js {{quote(phase)}} {{quote(run)}} {{quote(parent)}}

async-replay run:
  pnpm build
  node dist/evals/async-tuning/replay.js {{quote(run)}}

usable-test:
  pnpm usable:test

usable-eval:
  pnpm usable:eval

usable-replay run:
  pnpm usable:replay {{quote(run)}}

usable-benchmark input output:
  pnpm build
  node dist/evals/usable/benchmark-run.js {{quote(input)}} {{quote(output)}}

package:
  pnpm package:prepare
  pnpm package:test

complex-tlc java jar run: safety-build
  node dist/evals/collections-temporal/tlc-check.js {{quote(java)}} {{quote(jar)}} {{quote(run)}}

complex-eval run parent="": safety-build
  node dist/evals/collections-temporal/evaluate.js {{quote(run)}} {{quote(parent)}}

complex-replay run:
  pnpm build
  node dist/evals/collections-temporal/replay.js {{quote(run)}}

complex-tlc-replay java jar run:
  pnpm build
  node dist/evals/collections-temporal/tlc-replay.js {{quote(java)}} {{quote(jar)}} {{quote(run)}}
