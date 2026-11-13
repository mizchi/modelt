import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtimeFingerprint = async () => {
  const collect = async (directory: string): Promise<string[]> =>
    (
      await Promise.all(
        (
          await readdir(directory, { withFileTypes: true })
        ).map(async (entry) =>
          entry.isDirectory()
            ? collect(join(directory, entry.name))
            : entry.isFile() && /\.(ts|rs)$/.test(entry.name)
              ? [join(directory, entry.name)]
              : [],
        ),
      )
    ).flat();
  const files = [
    ...(
      await Promise.all(
        [
          "src",
          "examples",
          "evals/harness",
          "evals/runtime",
          "evals/rust-probe/src",
        ].map(collect),
      )
    ).flat(),
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    "evals/rust-probe/Cargo.toml",
    "evals/rust-probe/Cargo.lock",
  ].sort();
  const sources = await Promise.all(
    files.map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
  return {
    sourceVersion: createHash("sha256")
      .update(JSON.stringify(sources))
      .digest("hex"),
    sources,
  };
};
