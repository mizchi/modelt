import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileFiniteModel } from "../src/finite.js";

const consumer = await mkdtemp(join(tmpdir(), "modelt-go-consumer-"));
await mkdir(join(consumer, "sdk"));
for (const file of await readdir("adapters/go")) {
  if (
    file.endsWith("_test.go") ||
    (!["go.mod", "go.sum", "LICENSE"].includes(file) && !file.endsWith(".go"))
  )
    continue;
  await copyFile(join("adapters/go", file), join(consumer, "sdk", file));
}
await copyFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
  join(consumer, "modelt-core.wasm"),
);
const example = (await readFile("docs/go-adapter.md", "utf8")).match(
  /```go\n([\s\S]*?)\n```/,
)?.[1];
assert.ok(example, "Go usage example is missing");
await writeFile(join(consumer, "main.go"), example);
const toggle = compileFiniteModel<boolean, string, boolean>(
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
assert.ok(toggle.model);
await writeFile(join(consumer, "toggle.json"), JSON.stringify(toggle.model));
await writeFile(
  join(consumer, "go.mod"),
  `module modelt-consumer

go 1.25.0

require github.com/mizchi/modelt/adapters/go v0.0.0

replace github.com/mizchi/modelt/adapters/go => ./sdk
`,
);
await writeFile(
  join(consumer, "consumer_test.go"),
  `package main

import (
  "context"
  _ "embed"
  "testing"
  modelt "github.com/mizchi/modelt/adapters/go"
)

func TestStandalone(t *testing.T) {
  ctx := context.Background()
  core, err := modelt.New(ctx, wasm)
  if err != nil { t.Fatal(err) }
  defer core.Close(ctx)
  input, err := modelt.ValueOf(uint64(18446744073709551615))
  if err != nil { t.Fatal(err) }
  actual, err := core.Canonicalize(ctx, input)
  if err != nil { t.Fatal(err) }
  if string(actual) != string(input) { t.Fatalf("lost integer precision: %s", actual) }
  ranges, err := core.DeletionCandidates(ctx, 3)
  if err != nil || len(ranges) == 0 { t.Fatalf("no shrink candidates: %v", err) }
  loaded, err := core.LoadModel(ctx, model)
  if err != nil { t.Fatal(err) }
  defer loaded.Close(ctx)
  initial, _ := modelt.ValueOf(false)
  toggle, _ := modelt.ValueOf("toggle")
  observed, _ := modelt.ValueOf(true)
  history := modelt.ConcurrentHistory{Format:"modelt.concurrent-history",Version:1,Model:"toggle",Initial:initial,Events:[]modelt.HistoryEvent{{Kind:"invoke",ID:"a",Action:toggle},{Kind:"return",ID:"a",Observation:observed}}}
  checked, err := loaded.CheckHistory(ctx,history,100)
  if err != nil || checked.Status != "linearizable" { t.Fatalf("loaded history: %+v %v",checked,err) }
}
`,
);
const options = {
  cwd: consumer,
  env: { ...process.env, CGO_ENABLED: "0", GOPROXY: "off", GOSUMDB: "off" },
};
execFileSync("go", ["mod", "tidy"], options);
const output = execFileSync("go", ["test", "-count=1", "./..."], options)
  .toString()
  .trim();
assert.match(output, /ok\s+modelt-consumer/);
const exampleOutput = execFileSync("go", ["run", "."], options)
  .toString()
  .trim();
assert.equal(exampleOutput, "matched");
const result = {
  status: "complete",
  consumer,
  cgo: false,
  sdk: "copied standalone module",
  output,
  exampleOutput,
  wasmSha256: JSON.parse(await readFile(".artifacts/go/fixtures.json", "utf8"))
    .wasmSha256,
};
await mkdir(".artifacts/go", { recursive: true });
await writeFile(
  ".artifacts/go/consumer-result.json",
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result));
