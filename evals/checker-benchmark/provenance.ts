import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { fingerprint } from "../rust-safety/provenance.js";
import { digest } from "../usable/provenance.js";
import { nativePath, wasmPath } from "./engines.js";

export const sourceFingerprint = async () => {
  const source = await fingerprint();
  const paths = [
    "evals/plans/0016-checker-benchmark.md",
    ...(await readdir("evals/checker-benchmark"))
      .filter((path) => path.endsWith(".ts"))
      .map((path) => `evals/checker-benchmark/${path}`),
  ];
  const sources = [
    ...source.sources,
    ...(await Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: digest(await readFile(path)),
      })),
    )),
  ].sort((left, right) => left.path.localeCompare(right.path));
  return { sources, sourceVersion: digest(JSON.stringify(sources)) };
};

export const environment = async (
  java: string,
  jar: string,
  archive: string,
) => {
  const result = spawnSync(java, ["-XshowSettings:properties", "-version"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /os.arch = aarch64/);
  assert.equal(process.arch, "arm64");
  const binaries = await Promise.all(
    [java, jar, archive, nativePath, wasmPath].map(async (path) => ({
      path,
      sha256: digest(await readFile(path)),
    })),
  );
  return {
    node: process.version,
    arch: process.arch,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    cpus: cpus().length,
    memory: totalmem(),
    rust: execFileSync("rustc", ["--version"]).toString().trim(),
    java: result.stderr,
    tlaTs: JSON.parse(
      await readFile("node_modules/tla-ts/package.json", "utf8"),
    ).version,
    binaries,
  };
};
