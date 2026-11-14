import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Input, Route } from "./protocol.js";

export const runProcess = async (
  route: Route,
  input: Input,
  directory: string,
  log: string,
  java: string,
  jar: string,
) => {
  const scratch = await mkdtemp(join(tmpdir(), "modelt-benchmark-"));
  const moduleName = /^---- MODULE (\w+) ----/m.exec(input.source)?.[1];
  assert.ok(moduleName);
  const command = route === "tlc" ? resolve(java) : process.execPath;
  const args =
    route === "tlc"
      ? [
          "-XX:+UseParallelGC",
          `-Djava.io.tmpdir=${scratch}`,
          "-jar",
          resolve(jar),
          "-workers",
          "1",
          "-seed",
          "16",
          "-cleanup",
          "-config",
          `${moduleName}.cfg`,
          `${moduleName}.tla`,
        ]
      : [
          resolve("dist/evals/checker-benchmark/worker.js"),
          route,
          resolve(directory, "input.json"),
        ];
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd: route === "tlc" ? directory : process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `${route} exited ${result.status}: ${result.stderr}`,
    );
    const counts = /(\d+) states generated, (\d+) distinct states found/.exec(
      result.stdout,
    );
    const value: unknown =
      route === "tlc"
        ? {
            status: /Model checking completed. No error has been found/.test(
              result.stdout,
            )
              ? "complete"
              : "error",
            states: counts ? Number(counts[2]) : null,
            generated: counts ? Number(counts[1]) : null,
            violation: null,
          }
        : JSON.parse(result.stdout);
    return { milliseconds: performance.now() - start, value };
  } finally {
    await writeFile(
      log,
      JSON.stringify({
        command,
        args,
        exit: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
      { flag: "wx" },
    );
    await rm(scratch, { recursive: true, force: true });
  }
};
