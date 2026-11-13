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
    "examples",
    "adapters/go",
    "crates/modelt-core",
    "evals/cross-language",
    "evals/shared-oracle-rust",
    "evals/harness/counter-faults.ts",
    "evals/harness/search.ts",
    "evals/usable/provenance.ts",
    "evals/plans/0007-shared-oracle.md",
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
    [...new Set(paths)]
      .sort()
      .map(async (path) => ({ path, sha256: digest(await readFile(path)) })),
  );
  return { sources, sourceVersion: digest(JSON.stringify(sources)) };
};
