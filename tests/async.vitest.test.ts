import { test } from "vitest";
import { registerAsyncContract } from "./async-contract.js";

registerAsyncContract((name, run) => {
  test(name, run);
});
