import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const usableFingerprint = async () => {
  const files = [
    ...new Set(
      execFileSync("git", [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "src",
        "examples",
        "evals/usable",
        "evals/portable",
        "evals/harness",
        "evals/fixtures",
        "crates/modelt-core",
        "fixtures",
        "tests",
        "cli",
        "scripts",
        ".github",
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "tsconfig.build.json",
        "evals/plans/0005-usable-core.md",
      ])
        .toString()
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const sources = await Promise.all(
    files.map(async (path) => ({ path, sha256: digest(await readFile(path)) })),
  );
  return { sources, sourceVersion: digest(JSON.stringify(sources)) };
};
