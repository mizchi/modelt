import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { digest } from "../usable/provenance.js";

export const fingerprint = async () => {
  const paths = execFileSync("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "src",
    "scripts",
    "tests",
    "crates/modelt-core",
    "evals/rust-safety",
    "evals/collections-temporal",
    "evals/fixtures/channel",
    "evals/plans/0012-collections-temporal.md",
    "evals/plans/0013-scalar-comparison.md",
    "evals/plans/0014-value-hash.md",
    "evals/fixtures/die-hard",
    "evals/plans/0009-rust-safety.md",
    "evals/plans/0010-rust-safety-storage.md",
    "evals/plans/0011-rust-safety-arena.md",
    "justfile",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    ".github/workflows/ci.yml",
  ])
    .toString()
    .split("\0")
    .filter(Boolean);
  const sources = await Promise.all(
    [...new Set(paths)]
      .sort()
      .map(async (path) => ({ path, sha256: digest(await readFile(path)) })),
  );
  return { sources, sourceVersion: digest(JSON.stringify(sources)) };
};
