import { test } from "vitest";
import { registerAdvancedContract } from "./advanced-contract.js";
import { registerContract } from "./contract.js";

registerContract(test);
registerAdvancedContract(test);
