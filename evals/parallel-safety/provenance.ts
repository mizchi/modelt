import { readdir, readFile } from "node:fs/promises";
import { sourceFingerprint } from "../checker-benchmark/provenance.js";
import { digest } from "../usable/provenance.js";

export const fingerprint = async () => {
  const source = await sourceFingerprint();
  const paths = [
    "evals/plans/0017-parallel-safety.md",
    "evals/usable/native.ts",
    "evals/usable/provenance.ts",
    "playwright.config.ts",
    ...(await readdir("evals/parallel-safety"))
      .filter((path) => path.endsWith(".ts"))
      .map((path) => `evals/parallel-safety/${path}`),
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
