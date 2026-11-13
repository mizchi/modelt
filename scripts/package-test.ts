import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? ".artifacts/packages");
const files = await readdir(directory);
const tarball = files.find((file) => file.endsWith(".tgz"));
const crate = files.find((file) => file.endsWith(".crate"));
assert.ok(tarball && crate, "Prepare both packages first");
const consumer = await mkdtemp(join(tmpdir(), "modelt-consumer-"));
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify({ name: "modelt-consumer", private: true, type: "module" }),
);
execFileSync(
  "pnpm",
  [
    "add",
    join(directory, tarball),
    "--offline",
    "--ignore-scripts",
    "--lockfile=false",
    "--config.auto-install-peers=false",
    "--config.node-linker=hoisted",
  ],
  { cwd: consumer, stdio: "pipe" },
);
const artifact = {
  format: "modelt.finite-model",
  version: 1,
  name: "package-smoke",
  initial: [{ key: "0", observation: { type: "int", value: "0" } }],
  states: [
    {
      key: "0",
      violations: [],
      transitions: [
        {
          action: { type: "string", value: "tick" },
          target: "1",
          observation: { type: "int", value: "1" },
        },
      ],
    },
    { key: "1", violations: [], transitions: [] },
  ],
};
const history = {
  format: "modelt.portable-trace",
  version: 1,
  model: "package-smoke",
  initial: { type: "int", value: "0" },
  steps: [
    {
      action: { type: "string", value: "tick" },
      observation: { type: "int", value: "1" },
    },
  ],
};
await writeFile(join(consumer, "model.json"), JSON.stringify(artifact));
await writeFile(join(consumer, "history.json"), JSON.stringify(history));
await writeFile(
  join(consumer, "request.json"),
  JSON.stringify({
    version: 1,
    request: { kind: "check-finite", model: artifact, traces: [history] },
  }),
);
await writeFile(
  join(consumer, "consumer.mjs"),
  `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPortableWasm,checkFiniteHistories,decodePortableTrace} from '@mizchi/modelt/portable';
import {parseFiniteModel} from '@mizchi/modelt/finite';
import {createSimulationHost} from '@mizchi/modelt/host';
const core=await createPortableWasm(await readFile(new URL(import.meta.resolve('@mizchi/modelt/core.wasm'))));
const model=parseFiniteModel(JSON.parse(await readFile('model.json','utf8')));
const trace=decodePortableTrace(await readFile('history.json','utf8'));
assert.equal(checkFiniteHistories(core,model,[trace])[0].status,'matched');
assert.equal(createSimulationHost().now(),0);
for(const name of ['z3-solver','tla-ts','fast-check'])assert.throws(()=>import.meta.resolve(name));
console.log('packaged TS/Wasm consumer matched without solvers');
`,
);
const node = execFileSync(process.execPath, [join(consumer, "consumer.mjs")], {
  cwd: consumer,
})
  .toString()
  .trim();
await writeFile(
  join(consumer, "consumer.ts"),
  `import type {Model} from '@mizchi/modelt';
import {compileFiniteModel,createFiniteModel} from '@mizchi/modelt/finite';
import {createSimulationHost} from '@mizchi/modelt/host';
import {createPortableWasm} from '@mizchi/modelt/portable';
const model:Model<number,'tick',number>={name:'typed',initial:()=>[{state:0,observation:0}],actions:()=>['tick'],step:()=>[{state:0,observation:0}],key:String};
const compiled=compileFiniteModel(model,{maxDepth:1,maxStates:1});
if(compiled.model)createFiniteModel(compiled.model);
createSimulationHost({seed:1});
void createPortableWasm;
`,
);
execFileSync(
  process.execPath,
  [
    resolve("node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--target",
    "ES2023",
    "--module",
    "NodeNext",
    "consumer.ts",
  ],
  { cwd: consumer, stdio: "pipe" },
);
const cli = join(consumer, "node_modules/@mizchi/modelt/dist/cli/modelt.js");
const checked = spawnSync(
  process.execPath,
  [cli, "check", join(consumer, "model.json"), join(consumer, "history.json")],
  { encoding: "utf8" },
);
assert.equal(checked.status, 0, checked.stderr);
assert.equal(JSON.parse(checked.stdout).status, "matched");
await writeFile(
  join(consumer, "history.json"),
  JSON.stringify({
    ...history,
    steps: [{ ...history.steps[0], observation: { type: "int", value: "2" } }],
  }),
);
assert.equal(
  spawnSync(process.execPath, [
    cli,
    "check",
    join(consumer, "model.json"),
    join(consumer, "history.json"),
  ]).status,
  1,
);
await writeFile(
  join(consumer, "history.json"),
  JSON.stringify({
    ...history,
    steps: [
      { ...history.steps[0], action: { type: "string", value: "unknown" } },
    ],
  }),
);
assert.equal(
  spawnSync(process.execPath, [
    cli,
    "check",
    join(consumer, "model.json"),
    join(consumer, "history.json"),
  ]).status,
  2,
);
execFileSync("tar", ["-xzf", join(directory, crate), "-C", consumer]);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
await writeFile(
  join(consumer, "Cargo.toml"),
  `[package]\nname="modelt-consumer"\nversion="0.0.0"\nedition="2024"\n[dependencies]\nmodelt-core={path="modelt-core-${version}"}\n[[bin]]\nname="consumer"\npath="consumer.rs"\n`,
);
await writeFile(
  join(consumer, "consumer.rs"),
  `use modelt_core::{Engine,Message,Status};
fn main(){let bytes=std::fs::read("request.json").unwrap();let response=Engine::default().dispatch(&bytes);match response{Message::Results{results}=>assert_eq!(results[0].status,Status::Matched),_=>panic!("unexpected result")}println!("packaged Rust consumer matched");}
`,
);
const rust = execFileSync(
  "cargo",
  [
    "run",
    "--offline",
    "--quiet",
    "--manifest-path",
    join(consumer, "Cargo.toml"),
  ],
  { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] },
)
  .toString()
  .trim();
const result = {
  status: "complete",
  node,
  typecheck: "passed without solver declarations",
  rust,
  cliExitCodes: [0, 1, 2],
  consumer,
  artifacts: [tarball, crate],
};
await writeFile(
  join(directory, "consumer-result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result));
