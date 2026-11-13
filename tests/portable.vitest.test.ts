import { test } from "vitest";
import { registerPortableContract } from "./portable-contract.js";

registerPortableContract((name, run) => {
  test(name, run);
});
