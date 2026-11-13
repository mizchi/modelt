import { test } from "node:test";
import { registerAdvancedContract } from "./advanced-contract.js";
import { registerBudgetContract } from "./budget-contract.js";
import { registerContract } from "./contract.js";
import { registerEvalLoopContract } from "./eval-loop-contract.js";
import { registerEvaluationContract } from "./evaluation-contract.js";
import { registerIntegrationContract } from "./integration-contract.js";
import { registerPortableContract } from "./portable-contract.js";
import { registerPropertyContract } from "./property-contract.js";
import { registerShardingContract } from "./sharding-contract.js";
import { registerUsableContract } from "./usable-contract.js";

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
registerEvalLoopContract((name, run) => {
  test(name, run);
});
registerBudgetContract((name, run) => {
  test(name, run);
});
registerShardingContract((name, run) => {
  test(name, run);
});
registerPortableContract((name, run) => {
  test(name, run);
});
registerUsableContract((name, run) => {
  test(name, run);
});
