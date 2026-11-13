import { test } from "node:test";
import { registerAdvancedContract } from "./advanced-contract.js";
import { registerContract } from "./contract.js";
import { registerEvaluationContract } from "./evaluation-contract.js";
import { registerIntegrationContract } from "./integration-contract.js";
import { registerPropertyContract } from "./property-contract.js";

registerContract((name, run) => {
  test(name, run);
});
registerAdvancedContract((name, run) => {
  test(name, run);
});
registerPropertyContract((name, run) => {
  test(name, run);
});
registerIntegrationContract((name, run) => {
  test(name, run);
});
registerEvaluationContract((name, run) => {
  test(name, run);
});
