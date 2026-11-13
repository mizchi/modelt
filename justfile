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

browser:
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

usable-test:
  pnpm usable:test

usable-eval:
  pnpm usable:eval

usable-replay run:
  pnpm usable:replay {{quote(run)}}

package:
  pnpm package:prepare
  pnpm package:test
