import { createManifest } from "../../src/sharding.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { bounds, cases } from "../checker-benchmark/protocol.js";
import { digest } from "../usable/provenance.js";
import type { SafetyJob } from "./protocol.js";

export const corpus = async (sourceVersion: string) => {
  const inputs = cases();
  const programs = inputs.map((input) => ({
    id: digest(JSON.stringify([input.source, input.config])),
    program: compileTlaSafety(input),
  }));
  const manifest = await createManifest(
    { workload: "parallel-safety", sourceVersion },
    [
      ...Array.from({ length: 8 }, (_, round) =>
        inputs.map((input, index) => ({
          key: `mixed/${round}/${input.name}`,
          payload: {
            workload: "mixed",
            name: input.name,
            program: programs[index]?.id ?? "",
            bounds,
            states: input.states,
            generated: input.generated,
          },
        })),
      ).flat(),
      ...Array.from({ length: 256 }, (_, round) => {
        const input = inputs.find((input) => input.name === "grid-20");
        const program = input && programs[inputs.indexOf(input)];
        if (!input || !program) throw new Error("Missing small-task fixture");
        return {
          key: `tiny/${round}`,
          payload: {
            workload: "tiny",
            name: input.name,
            program: program.id,
            bounds,
            states: input.states,
            generated: input.generated,
          },
        };
      }),
    ],
  );
  const ordered = [...manifest.tasks].sort((left, right) => {
    const leftParts = left.key.split("/");
    const rightParts = right.key.split("/");
    return (
      leftParts[0]?.localeCompare(rightParts[0] ?? "") ||
      Number(leftParts[1]) - Number(rightParts[1]) ||
      inputs.findIndex((input) => input.name === left.payload.name) -
        inputs.findIndex((input) => input.name === right.payload.name)
    );
  });
  const jobs: readonly SafetyJob[] = ordered.map((task) => ({
    id: task.id,
    program: task.payload.program,
    bounds: task.payload.bounds,
    estimatedMs: 0,
    memoryBytes:
      32 * 1024 * 1024 +
      task.payload.states *
        (["set-delivery-12", "function-nodes-12", "sequence-queue-10"].includes(
          task.payload.name,
        )
          ? 512
          : 128),
  }));
  return { inputs, programs, manifest, jobs };
};
