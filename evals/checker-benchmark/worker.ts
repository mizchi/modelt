import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadEngines } from "./engines.js";
import type { Input } from "./protocol.js";

const route = process.argv[2];
const path = process.argv[3];
assert.ok(
  route === "tla-ts" || route === "modelt-wasm" || route === "modelt-native",
);
assert.ok(path);
const input: Input = JSON.parse(await readFile(path, "utf8"));
const engines = await loadEngines([route]);
try {
  console.log(JSON.stringify(await engines.run(route, input)));
} finally {
  await engines.close();
}
