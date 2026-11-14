import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SafetyResult } from "../../src/contracts.js";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety } from "../../src/safety.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { bounds, cases } from "./cases.js";
import { fingerprint } from "./provenance.js";

interface TlcReport {
  readonly name: string;
  readonly input: {
    readonly name: string;
    readonly source: string;
    readonly config: string;
  };
  readonly tlcExit: number | null;
  readonly status: string;
  readonly ours: SafetyResult | { readonly error: string | undefined };
  readonly log: string;
}

const java = process.argv[2];
const jar = process.argv[3];
assert.ok(java && jar, "Pass a Java executable and tla2tools.jar");
await mkdir(".artifacts", { recursive: true });
const directory = await mkdtemp(resolve(".artifacts/tlc-compare-"));
const core = await createPortableWasm(
  await readFile(
    "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
  ),
);
const dieHard = await readFile("evals/fixtures/die-hard/DieHard.tla", "utf8");
const inputs = [
  ...cases.filter((entry) => !entry.bounds),
  ...["TypeOK", "TypeOK NotSolved"].map((invariants) => ({
    name: `DieHard-${invariants.replaceAll(" ", "-")}`,
    source: dieHard,
    config: `INIT Init\nNEXT Next\nINVARIANT ${invariants}`,
  })),
];
const reports: TlcReport[] = [];
for (const [index, input] of inputs.entries()) {
  const program = compileTlaSafety(input);
  await writeFile(join(directory, `${program.name}.tla`), input.source);
  await writeFile(join(directory, `${program.name}.cfg`), input.config);
  const processResult: SpawnSyncReturns<string> = spawnSync(
    java.includes("/") ? resolve(java) : java,
    [
      "-XX:+UseParallelGC",
      "-jar",
      resolve(jar),
      "-workers",
      "1",
      "-cleanup",
      "-config",
      `${program.name}.cfg`,
      `${program.name}.tla`,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  if (processResult.error) throw processResult.error;
  const log: string = processResult.stdout + processResult.stderr;
  await writeFile(join(directory, `${index}.log`), log);
  const counts = /(\d+) states generated, (\d+) distinct states found/.exec(
    log,
  );
  const status: string =
    /Invariant .* is violated|Invariant .* is violated by the initial state/.test(
      log,
    )
      ? "invariant-violation"
      : /Deadlock reached/.test(log)
        ? "deadlock"
        : /Assumption .* is false/.test(log)
          ? "assumption-violation"
          : processResult.status === 0
            ? counts?.[2] === "0"
              ? "empty"
              : "complete"
            : "error";
  let ours: ReturnType<typeof checkSafety> | undefined;
  let error: string | undefined;
  try {
    ours = checkSafety(core, program, bounds);
  } catch (failure) {
    error = String(failure);
  }
  assert.equal(ours?.status ?? "error", status, `${input.name}: ${log}`);
  if (ours && counts) {
    assert.equal(ours.generated, Number(counts[1]), input.name);
    assert.equal(ours.states, Number(counts[2]), input.name);
  }
  if (ours?.violation && status !== "assumption-violation") {
    const blocks = [
      ...log.matchAll(
        /State \d+:[^\n]*\n([\s\S]*?)(?=\nState \d+:|\n\d+ states generated|$)/g,
      ),
    ].map((match) => match[1] ?? "");
    if (
      blocks.length === 0 &&
      ours.violation.trace.length === 1 &&
      /violated by the initial state/.test(log)
    )
      blocks.push(log);
    const actualTrace = blocks.map((block) => {
      const assignments = new Map(
        [...block.matchAll(/(?:\/\\ )?(\w+) = (TRUE|FALSE|-?\d+)/g)].map(
          (value) => [value[1], value[2]],
        ),
      );
      return program.variables.map((name) => {
        const value = assignments.get(name);
        assert.ok(value, `${input.name}: missing ${name}`);
        return value === "TRUE"
          ? true
          : value === "FALSE"
            ? false
            : Number(value);
      });
    });
    assert.deepEqual(
      ours.violation.trace.map((step) =>
        step.values.map((value) =>
          value.type === "bool"
            ? value.value
            : Number(value.type === "int" ? value.value : NaN),
        ),
      ),
      actualTrace,
      input.name,
    );
  }
  reports.push({
    name: input.name,
    input,
    tlcExit: processResult.status,
    status,
    ours: ours ?? { error },
    log: `${index}.log`,
  });
}
await writeFile(
  join(directory, "result.json"),
  JSON.stringify(
    {
      status: "complete",
      ...(await fingerprint()),
      commit: spawnSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim(),
      java: spawnSync(java.includes("/") ? resolve(java) : java, ["-version"], {
        encoding: "utf8",
      }).stderr.trim(),
      jarSha256: createHash("sha256")
        .update(await readFile(jar))
        .digest("hex"),
      reports,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ status: "complete", cases: reports.length, directory }),
);
