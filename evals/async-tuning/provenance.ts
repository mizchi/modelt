import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { digest } from "../usable/provenance.js";

export const fingerprint = async () => {
  const files = execFileSync("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "src",
    "scripts",
    "tests",
    "examples",
    "adapters/go",
    "crates/modelt-core",
    "evals/async-tuning",
    "evals/harness",
    "evals/cross-language",
    "evals/shared-oracle-rust",
    "evals/usable/mutex.ts",
    "evals/usable/provenance.ts",
    "evals/fixtures",
    "evals/plans/0008-async-tuning.md",
    "justfile",
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
  ])
    .toString()
    .split("\0")
    .filter(Boolean);
  const sources = await Promise.all(
    [...new Set(files)]
      .sort()
      .map(async (path) => ({ path, sha256: digest(await readFile(path)) })),
  );
  return { sources, sourceVersion: digest(JSON.stringify(sources)) };
};
