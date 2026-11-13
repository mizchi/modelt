import { test } from "vitest";
import { registerUsableContract } from "./usable-contract.js";

registerUsableContract((name, run) => {
  test(name, run);
});
