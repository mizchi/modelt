import { test } from "vitest";
import { registerSafetyContract } from "./safety-contract.js";

registerSafetyContract((name, run) => {
  test(name, run);
});
