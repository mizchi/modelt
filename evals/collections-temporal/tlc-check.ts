import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SafetyResult } from "../../src/contracts.js";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety } from "../../src/safety.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { fingerprint } from "../rust-safety/provenance.js";
import { digest } from "../usable/provenance.js";
import { bounds, cases } from "./cases.js";
import { runTlc, traceInput } from "./tlc.js";

const [java, jar, directory] = process.argv.slice(2);
assert.ok(
  java && jar && directory,
  "Pass Java, TLC jar and a new output directory",
);
await mkdir(directory, { recursive: false });
const bytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
const core = await createPortableWasm(bytes);
const reports = [];
for (const input of cases.filter((input) => !input.bounds)) {
  const program = compileTlaSafety(input);
  let ours: { result?: SafetyResult; error?: string };
  try {
    ours = { result: checkSafety(core, program, bounds) };
  } catch (error) {
    ours = { error: String(error) };
  }
  const reference = await runTlc(
    java,
    jar,
    join(directory, input.name),
    input,
    program.name,
  );
  const expected =
    input.expected === "property-violation"
      ? "liveness-violation"
      : input.expected;
  assert.equal(reference.status, expected, `${input.name}: ${reference.log}`);
  assert.equal(ours.result?.status ?? "error", input.expected, input.name);
  if (ours.result?.status === "complete") {
    assert.equal(ours.result.states, reference.states, input.name);
    assert.equal(ours.result.generated, reference.generated, input.name);
  }
  let replay: Awaited<ReturnType<typeof runTlc>> | undefined;
  let forced: ReturnType<typeof traceInput> | undefined;
  if (
    ours.result?.violation?.trace.length &&
    ours.result.status !== "deadlock"
  ) {
    forced = traceInput(input, program, ours.result);
    replay = await runTlc(
      java,
      jar,
      join(directory, `${input.name}-witness`),
      forced,
      program.name,
    );
    assert.equal(
      replay.status,
      forced.expected,
      `${input.name} witness: ${replay.log}`,
    );
    assert.equal(
      replay.states,
      ours.result.violation.trace.length,
      `${input.name}: unreachable witness state`,
    );
  }
  reports.push({
    input,
    module: program.name,
    ours,
    reference,
    ...(replay && forced ? { replay, forced } : {}),
  });
  console.log(input.name, reference.status, replay ? "witness verified" : "");
}
const controlCase = reports.find(
  (report) => report.input.name === "eventually-always-WF",
);
assert.ok(controlCase?.ours.result);
const controlInput = traceInput(
  controlCase.input,
  compileTlaSafety(controlCase.input),
  controlCase.ours.result,
  false,
);
const controlResult = await runTlc(
  java,
  jar,
  join(directory, "negative-control"),
  controlInput,
  controlCase.module,
);
assert.equal(controlResult.status, "liveness-violation");
const files = [];
for (const entry of await readdir(directory, { withFileTypes: true }))
  if (entry.isDirectory())
    for (const name of await readdir(join(directory, entry.name)))
      if (/\.(tla|cfg|log)$/.test(name)) {
        const path = join(entry.name, name);
        files.push({
          path,
          sha256: digest(await readFile(join(directory, path))),
        });
      }
const source = await fingerprint();
await writeFile(
  join(directory, "result.json"),
  JSON.stringify(
    {
      status: "complete",
      plan: "0012-collections-temporal",
      ...source,
      commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
      wasmSha256: digest(bytes),
      jarSha256: digest(await readFile(jar)),
      java: spawnSync(java, ["-version"], { encoding: "utf8" }).stderr.trim(),
      reports,
      files,
      control: {
        input: controlInput,
        module: controlCase.module,
        result: controlResult,
      },
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    directory,
    cases: reports.length,
    witnesses: reports.filter((report) => report.replay).length,
  }),
);
