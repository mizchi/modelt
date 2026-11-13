export {
  checkModel,
  type ExplorationBounds,
  type ExplorationResult,
} from "./checker.js";
export {
  type CompositionOptions,
  composeModels,
  type ProductAction,
  type ProductObservation,
  type ProductState,
} from "./compose.js";
export {
  checkConformance,
  checkDifferential,
  checkTrace,
} from "./conformance.js";
export type {
  Comparison,
  ConformanceResult,
  Driver,
  Model,
  Trace,
  Transition,
} from "./contracts.js";
export {
  decodeTrace,
  encodeTrace,
  equalValues,
  TraceFormatError,
  type TraceGuards,
} from "./trace.js";
