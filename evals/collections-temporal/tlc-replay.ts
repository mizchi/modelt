import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fingerprint } from "../rust-safety/provenance.js";
import { digest } from "../usable/provenance.js";
import type { Case } from "./cases.js";
import { runTlc } from "./tlc.js";

interface Saved {
  readonly status: string;
  readonly sourceVersion: string;
  readonly jarSha256: string;
  readonly wasmSha256: string;
  readonly files: readonly { path: string; sha256: string }[];
  readonly reports: readonly {
    input: Case;
    module: string;
    reference: Awaited<ReturnType<typeof runTlc>>;
    forced?: Pick<Case, "source" | "config">;
    replay?: Awaited<ReturnType<typeof runTlc>>;
  }[];
  readonly control: {
    input: Pick<Case, "source" | "config">;
    module: string;
    result: Awaited<ReturnType<typeof runTlc>>;
  };
}
const [java, jar, directory] = process.argv.slice(2);
assert.ok(java && jar && directory);
const saved: Saved = JSON.parse(
  await readFile(join(directory, "result.json"), "utf8"),
);
assert.equal(saved.status, "complete");
assert.equal(
  saved.sourceVersion,
  (await fingerprint()).sourceVersion,
  "Check out recorded sources before replay",
);
assert.equal(saved.jarSha256, digest(await readFile(jar)));
assert.equal(
  saved.wasmSha256,
  digest(
    await readFile(
      "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
    ),
  ),
);
for (const file of saved.files)
  assert.equal(file.sha256, digest(await readFile(join(directory, file.path))));
const output = await mkdtemp(resolve(".artifacts/tlc-replay-"));
const compare = async (
  name: string,
  input: Pick<Case, "source" | "config">,
  module: string,
  expected: Awaited<ReturnType<typeof runTlc>>,
) => {
  const actual = await runTlc(java, jar, join(output, name), input, module);
  assert.equal(actual.status, expected.status, name);
  assert.equal(actual.states, expected.states, name);
  assert.equal(actual.generated, expected.generated, name);
};
for (const report of saved.reports) {
  await compare(
    report.input.name,
    report.input,
    report.module,
    report.reference,
  );
  if (report.forced && report.replay)
    await compare(
      `${report.input.name}-witness`,
      report.forced,
      report.module,
      report.replay,
    );
}
await compare(
  "negative-control",
  saved.control.input,
  saved.control.module,
  saved.control.result,
);
console.log(
  JSON.stringify({
    reports: saved.reports.length,
    witnesses: saved.reports.filter((report) => report.replay).length,
    output,
  }),
);
