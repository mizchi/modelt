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
