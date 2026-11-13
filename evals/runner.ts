import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/trace.js";
import { benchmark } from "./benchmark.js";
import {
  type EvaluationPlan,
  EvaluationProtocolError,
  isRunId,
  parsePlan,
} from "./protocol.js";

export type Split = "development" | "confirmation";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeJson = async (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));

export const readPlan = async (path: string): Promise<EvaluationPlan> =>
  parsePlan(await readJson(path));

export const readCompletedRun = async (directory: string) => {
  const manifest = await readJson(join(directory, "manifest.json"));
  const result = await readJson(join(directory, "result.json"));
  const trials = await readJson(join(directory, "trials.json"));
  const corpora = await readJson(join(directory, "corpora.json"));
  const witnesses = await readJson(join(directory, "witnesses.json"));
  if (
    !isRecord(manifest) ||
    !isRecord(result) ||
    result.status !== "complete" ||
    result.runId !== manifest.runId ||
    result.split !== manifest.split ||
    result.manifestDigest !== digest(manifest) ||
    result.trialsDigest !== digest(trials) ||
    result.corporaDigest !== digest(corpora) ||
    result.witnessesDigest !== digest(witnesses)
  )
    throw new EvaluationProtocolError("Invalid completed evaluation evidence");
  return { manifest, result, trials, corpora, witnesses };
};

const fingerprint = async () => {
  const collect = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map(async (entry) =>
          entry.isDirectory()
            ? collect(join(directory, entry.name))
            : entry.isFile() && entry.name.endsWith(".ts")
              ? [join(directory, entry.name)]
              : [],
        ),
      )
    ).flat();
  };
  const entrypoints = (await readdir("evals", { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join("evals", entry.name));
  const paths = [
    ...(
      await Promise.all(["src", "examples", "evals/harness"].map(collect))
    ).flat(),
    ...entrypoints,
    "package.json",
    "pnpm-lock.yaml",
  ].sort();
  const files = await Promise.all(
    paths.map(async (path) => ({
      path: path.replaceAll("\\", "/"),
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
  return { sourceDigest: digest(files), files };
};

export const runEvaluation = async (
  input: EvaluationPlan,
  split: Split,
  runId: string,
  outputRoot = "evals/runs",
  parentRun?: string,
) => {
  const plan = parsePlan(input);
  if (!isRunId(runId) || (parentRun !== undefined && !isRunId(parentRun)))
    throw new EvaluationProtocolError("Invalid run ID");
  if (split !== "development" && split !== "confirmation")
    throw new EvaluationProtocolError("Invalid split");
  const source = await fingerprint();
  const planDigest = digest(plan);
  const parent = await (async () => {
    if (split !== "confirmation") return null;
    if (!parentRun)
      throw new EvaluationProtocolError(
        "Confirmation requires a development run",
      );
    const previous = await readCompletedRun(join(outputRoot, parentRun));
    const manifest = previous.manifest;
    if (manifest.split !== "development" || manifest.runId !== parentRun)
      throw new EvaluationProtocolError("Expected a development run");
    if (manifest.planDigest !== planDigest)
      throw new EvaluationProtocolError(
        "Confirmation plan differs from development",
      );
    if (manifest.sourceDigest !== source.sourceDigest)
      throw new EvaluationProtocolError(
        "Confirmation implementation differs from development",
      );
    return { runId: parentRun, resultDigest: digest(previous.result) };
  })();
  await mkdir(outputRoot, { recursive: true });
  const directory = join(outputRoot, runId);
  await mkdir(directory);
  const manifest = {
    version: 1,
    runId,
    split,
    startedAt: new Date().toISOString(),
    plan,
    planDigest,
    ...source,
    parent,
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirtyPaths: execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  await writeJson(join(directory, "manifest.json"), manifest);
  try {
    const data = await benchmark(
      plan,
      split === "development" ? plan.developmentSeeds : plan.confirmationSeeds,
    );
    if ((await fingerprint()).sourceDigest !== source.sourceDigest)
      throw new EvaluationProtocolError(
        "Implementation changed during the run",
      );
    await writeJson(join(directory, "trials.json"), data.trials);
    await writeJson(join(directory, "corpora.json"), data.corpora);
    await writeJson(join(directory, "witnesses.json"), data.witnesses);
    const result = {
      runId,
      split,
      status:
        data.comparison.assessment === "controls-failed"
          ? "controls-failed"
          : "complete",
      ...data.comparison,
      assessmentBasis:
        "detection counts by fault; costs require separate review; no automatic adoption",
      finishedAt: new Date().toISOString(),
      manifestDigest: digest(manifest),
      trialsDigest: digest(data.trials),
      corporaDigest: digest(data.corpora),
      witnessesDigest: digest(data.witnesses),
    };
    await appendFile(
      join(outputRoot, "ledger.jsonl"),
      `${JSON.stringify({ runId, split, planId: plan.id, planDigest, sourceDigest: source.sourceDigest, status: result.status, assessment: result.assessment })}\n`,
    );
    await writeJson(join(directory, "result.json"), result);
    return result;
  } catch (error) {
    await writeJson(join(directory, "error.json"), {
      status: "error",
      finishedAt: new Date().toISOString(),
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    await appendFile(
      join(outputRoot, "ledger.jsonl"),
      `${JSON.stringify({ runId, split, planId: plan.id, status: "error" })}\n`,
    );
    throw error;
  }
};
