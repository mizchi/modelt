import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../usable/provenance.js";
import type { Report } from "./verify.js";

interface Seal {
  readonly status: string;
  readonly sourceVersion: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}
export const readEvidence = async (directory: string) => {
  const bytes = await readFile(join(directory, "result.json"));
  const result: Seal = JSON.parse(bytes.toString());
  assert.equal(result.status, "complete");
  assert.deepEqual(result.files.map((file) => file.path).sort(), [
    "checks.json",
    "controls.json",
    "manifest.json",
  ]);
  for (const file of result.files)
    assert.equal(
      file.sha256,
      digest(await readFile(join(directory, file.path))),
    );
  const reports: Report[] = JSON.parse(
    await readFile(join(directory, "checks.json"), "utf8"),
  );
  return {
    reports,
    sourceVersion: result.sourceVersion,
    sha256: digest(bytes),
  };
};
