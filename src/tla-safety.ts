import {
  type ConfigValue,
  type Module,
  parseConfig,
  parseModule,
} from "tla-ts";
import type {
  SafetyBranch,
  SafetyDomain,
  SafetyExpression,
  SafetyProgram,
  SafetyStep,
} from "./contracts.js";
import { PortableCoreError } from "./portable-value.js";

type Expression = Module["definitions"][number]["body"];
interface Context {
  readonly phase: "initial" | "next" | "state" | "constant";
  readonly locals: ReadonlyMap<string, SafetyExpression>;
  readonly calls: readonly string[];
  readonly depth: number;
}

const getLevel = (value: SafetyExpression): number => {
  switch (value.op) {
    case "literal":
      return 0;
    case "read":
      return value.next ? 2 : 1;
    case "neg":
    case "not":
      return getLevel(value.argument);
    case "if":
      return Math.max(
        getLevel(value.condition),
        getLevel(value.consequent),
        getLevel(value.alternative),
      );
    case "in":
      return value.domain.kind === "range"
        ? Math.max(
            getLevel(value.value),
            getLevel(value.domain.lower),
            getLevel(value.domain.upper),
          )
        : value.domain.values.reduce(
            (level, entry) => Math.max(level, getLevel(entry)),
            getLevel(value.value),
          );
    default:
      return Math.max(getLevel(value.left), getLevel(value.right));
  }
};

export const compileTlaSafety = (options: {
  readonly source: string;
  readonly config: string;
}): SafetyProgram => {
  const module = parseModule(options.source);
  const config = parseConfig(options.config);
  const unsupported = (message: string): never => {
    throw new PortableCoreError(
      "protocol",
      `Unsupported TLA safety input: ${message}`,
    );
  };
  if (
    module.modules.length ||
    module.instances.length ||
    module.extends.some((name) => name !== "Naturals" && name !== "Integers")
  )
    unsupported("modules or EXTENDS");
  if (
    config.specification ||
    config.properties.length ||
    config.constraints.length ||
    config.actionConstraints.length ||
    config.substitutions.length ||
    config.symmetry ||
    config.view ||
    config.alias ||
    config.postconditions.length ||
    config.possible.length ||
    config.periodic ||
    config.rlReward
  )
    unsupported(
      "configuration requires INIT / NEXT / INVARIANT without temporal or constrained options",
    );
  if (!config.init || !config.next) unsupported("INIT and NEXT are required");
  const variables = module.variables.map((value) => value.name);
  if (
    !variables.length ||
    variables.length > 256 ||
    new Set(variables).size !== variables.length ||
    module.variables.some((value) => value.arity !== 0)
  )
    unsupported("state variables");
  const slots = new Map(variables.map((name, index) => [name, index]));
  const definitions = new Map(
    module.definitions.map((value) => [value.name, value]),
  );
  if (definitions.size !== module.definitions.length)
    unsupported("duplicate operators");
  const symbols = [
    ...variables,
    ...module.constants.map((value) => value.name),
    ...definitions.keys(),
  ];
  if (
    new Set(symbols).size !== symbols.length ||
    module.definitions.some(
      (definition) =>
        definition.kind !== "Operator" ||
        definition.params.some((param) => symbols.includes(param.name)) ||
        new Set(definition.params.map((param) => param.name)).size !==
          definition.params.length,
    )
  )
    unsupported("conflicting symbols or function definitions");
  const constants = new Map<string, ConfigValue>();
  for (const assignment of config.constants) {
    if (assignment.module || assignment.args || constants.has(assignment.name))
      unsupported("constant assignment");
    constants.set(assignment.name, assignment.value);
  }
  if (
    module.constants.some(
      (value) => value.arity !== 0 || !constants.has(value.name),
    ) ||
    [...constants.keys()].some(
      (name) => !module.constants.some((value) => value.name === name),
    )
  )
    unsupported("missing or extra constants");
  const literal = (value: ConfigValue): SafetyExpression => {
    if (value.kind === "Boolean")
      return { op: "literal", value: { type: "bool", value: value.value } };
    if (
      value.kind === "Number" &&
      Number.isInteger(value.value) &&
      value.value >= -2147483648 &&
      value.value <= 2147483647
    )
      return {
        op: "literal",
        value: { type: "int", value: String(value.value) },
      };
    return unsupported(
      "only signed 32 bit integer and boolean literals are supported",
    );
  };
  const nested = (context: Context): Context => {
    if (context.depth >= 40)
      return unsupported("expression or operator nesting exceeds 40");
    return { ...context, depth: context.depth + 1 };
  };
  const call = (
    name: string,
    args: readonly Expression[],
    context: Context,
  ) => {
    const definition = definitions.get(name);
    if (
      definition?.kind !== "Operator" ||
      definition.isRecursive ||
      context.calls.includes(name) ||
      definition.params.length !== args.length ||
      definition.params.some((param) => param.arity !== 0)
    )
      return unsupported(`operator ${name}`);
    const locals = new Map<string, SafetyExpression>();
    for (const [index, param] of definition.params.entries()) {
      const argument = args[index];
      if (!argument) return unsupported(`operator argument ${name}`);
      locals.set(param.name, expression(argument, context));
    }
    return {
      body: definition.body,
      context: { ...nested(context), locals, calls: [...context.calls, name] },
    };
  };
  const domain = (
    value: Expression,
    context: Context,
    choice = false,
  ): SafetyDomain => {
    if (value.kind === "SetEnumeration")
      return {
        kind: "set",
        values: value.elements.map((entry) =>
          expression(entry, nested(context)),
        ),
      };
    if (
      value.kind === "Apply" &&
      value.operator === ".." &&
      value.args[0] &&
      value.args[1]
    ) {
      if (
        !module.extends.some(
          (name) => name === "Naturals" || name === "Integers",
        )
      )
        return unsupported("range requires Naturals or Integers");
      return {
        kind: "range",
        lower: expression(value.args[0], nested(context)),
        upper: expression(value.args[1], nested(context)),
      };
    }
    if (value.kind === "Identifier") {
      const constant = constants.get(value.name);
      if (constant?.kind === "Set")
        return { kind: "set", values: constant.elements.map(literal) };
      if (value.name === "BOOLEAN")
        return {
          kind: "set",
          values: [
            literal({ kind: "Boolean", value: false }),
            literal({ kind: "Boolean", value: true }),
          ],
        };
      if (
        !choice &&
        (value.name === "Nat" || value.name === "Int") &&
        (module.extends.includes("Integers") ||
          (value.name === "Nat" && module.extends.includes("Naturals")))
      )
        return {
          kind: "range",
          lower: literal({
            kind: "Number",
            value: value.name === "Nat" ? 0 : -2147483648,
          }),
          upper: literal({ kind: "Number", value: 2147483647 }),
        };
      const expanded = call(value.name, [], context);
      return domain(expanded.body, expanded.context, choice);
    }
    return unsupported(`finite domain ${value.kind}`);
  };
  const binary = new Map<
    string,
    "add" | "sub" | "mul" | "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "implies"
  >([
    ["+", "add"],
    ["-", "sub"],
    ["*", "mul"],
    ["=", "eq"],
    ["#", "ne"],
    ["/=", "ne"],
    ["<", "lt"],
    ["<=", "le"],
    ["\\leq", "le"],
    [">", "gt"],
    [">=", "ge"],
    ["\\geq", "ge"],
    ["=>", "implies"],
  ]);
  const expression = (
    value: Expression,
    context: Context,
  ): SafetyExpression => {
    const child = nested(context);
    if (value.kind === "Number")
      return literal({ kind: "Number", value: value.value });
    if (value.kind === "Identifier") {
      const local = context.locals.get(value.name);
      if (local) return local;
      const constant = constants.get(value.name);
      if (constant) return literal(constant);
      if (value.name === "TRUE" || value.name === "FALSE")
        return literal({ kind: "Boolean", value: value.name === "TRUE" });
      const slot = slots.get(value.name);
      if (slot !== undefined) {
        if (context.phase === "constant")
          return unsupported("variable in constant expression");
        return { op: "read", slot, next: context.phase === "initial" };
      }
      const expanded = call(value.name, [], context);
      return expression(expanded.body, expanded.context);
    }
    if (
      value.kind === "Prime" &&
      value.expression.kind === "Identifier" &&
      context.phase === "next"
    ) {
      const slot = slots.get(value.expression.name);
      if (slot !== undefined) return { op: "read", slot, next: true };
    }
    if (value.kind === "If")
      return {
        op: "if",
        condition: expression(value.condition, child),
        consequent: expression(value.consequent, child),
        alternative: expression(value.alternative, child),
      };
    if (value.kind === "And" || value.kind === "Or") {
      const operands = value.operands.map((entry) => expression(entry, child));
      return operands.reduce<SafetyExpression>(
        (left, right) => ({
          op: value.kind === "And" ? "and" : "or",
          left,
          right,
        }),
        literal({ kind: "Boolean", value: value.kind === "And" }),
      );
    }
    if (value.kind === "Apply") {
      if (definitions.has(value.operator)) {
        const expanded = call(value.operator, value.args, context);
        return expression(expanded.body, expanded.context);
      }
      const first = value.args[0];
      const second = value.args[1];
      if (
        value.operator === "-." ||
        (value.operator === "-" && value.args.length === 1)
      ) {
        if (!module.extends.includes("Integers"))
          return unsupported("unary minus requires Integers");
        if (first?.kind === "Number" && first.value === 2147483648)
          return literal({ kind: "Number", value: -2147483648 });
      }
      if (
        (value.operator === "~" ||
          value.operator === "\\lnot" ||
          value.operator === "-." ||
          (value.operator === "-" && value.args.length === 1)) &&
        first &&
        value.args.length === 1
      )
        return {
          op:
            value.operator === "~" || value.operator === "\\lnot"
              ? "not"
              : "neg",
          argument: expression(first, child),
        };
      if (
        value.operator === "\\in" &&
        first &&
        second &&
        value.args.length === 2
      )
        return {
          op: "in",
          value: expression(first, child),
          domain: domain(second, child),
        };
      const op = binary.get(value.operator);
      if (
        op &&
        ["add", "sub", "mul", "lt", "le", "gt", "ge"].includes(op) &&
        !module.extends.some(
          (name) => name === "Naturals" || name === "Integers",
        )
      )
        return unsupported("arithmetic requires Naturals or Integers");
      if (op && first && second && value.args.length === 2)
        return {
          op,
          left: expression(first, child),
          right: expression(second, child),
        };
    }
    return unsupported(
      `expression ${value.kind}${value.kind === "Apply" ? ` ${value.operator}` : ""}`,
    );
  };
  const target = (value: Expression, context: Context): number | undefined => {
    if (
      context.phase === "initial" &&
      value.kind === "Identifier" &&
      !context.locals.has(value.name)
    )
      return slots.get(value.name);
    if (
      context.phase === "next" &&
      value.kind === "Prime" &&
      value.expression.kind === "Identifier" &&
      !context.locals.has(value.expression.name)
    )
      return slots.get(value.expression.name);
    return undefined;
  };
  const limited = (
    branches: readonly SafetyBranch[],
  ): readonly SafetyBranch[] => {
    if (
      branches.length > 4096 ||
      branches.some((branch) => branch.steps.length > 256)
    )
      return unsupported("action expansion exceeds 4096 branches or 256 steps");
    return branches;
  };
  const action = (
    value: Expression,
    context: Context,
    name: string,
  ): readonly SafetyBranch[] => {
    const child = nested(context);
    if (value.kind === "Identifier" && definitions.has(value.name)) {
      const expanded = call(value.name, [], context);
      return action(expanded.body, expanded.context, value.name);
    }
    if (value.kind === "Apply" && definitions.has(value.operator)) {
      const expanded = call(value.operator, value.args, context);
      return action(expanded.body, expanded.context, value.operator);
    }
    if (value.kind === "Or")
      return limited(
        value.operands.flatMap((entry) => action(entry, child, name)),
      );
    if (value.kind === "And")
      return value.operands.reduce<readonly SafetyBranch[]>(
        (branches, operand) => {
          const additions = action(operand, child, name);
          if (branches.length * additions.length > 4096)
            return unsupported("action expansion exceeds 4096 branches");
          return limited(
            branches.flatMap((branch) =>
              additions.map((addition) => ({
                name: addition.name,
                steps: [...branch.steps, ...addition.steps],
              })),
            ),
          );
        },
        [{ name, steps: [] }],
      );
    if (value.kind === "If") {
      const condition = expression(value.condition, child);
      return limited([
        ...action(value.consequent, child, name).map((branch) => ({
          ...branch,
          steps: [
            { kind: "guard", expression: condition },
            ...branch.steps,
          ] satisfies readonly SafetyStep[],
        })),
        ...action(value.alternative, child, name).map((branch) => ({
          ...branch,
          steps: [
            { kind: "guard", expression: { op: "not", argument: condition } },
            ...branch.steps,
          ] satisfies readonly SafetyStep[],
        })),
      ]);
    }
    if (value.kind === "Unchanged" && context.phase === "next") {
      const entries =
        value.expression.kind === "Tuple"
          ? value.expression.elements
          : [value.expression];
      return [
        {
          name,
          steps: entries.map((entry) => {
            if (entry.kind !== "Identifier" || context.locals.has(entry.name))
              return unsupported("UNCHANGED requires state variables");
            const slot = slots.get(entry.name);
            if (slot === undefined) return unsupported("UNCHANGED variable");
            return {
              kind: "assign",
              slot,
              value: { op: "read", slot, next: false },
            };
          }),
        },
      ];
    }
    if (
      value.kind === "Apply" &&
      value.args.length === 2 &&
      value.args[0] &&
      value.args[1]
    ) {
      const slot = target(value.args[0], context);
      if (slot !== undefined && value.operator === "=")
        return [
          {
            name,
            steps: [
              { kind: "assign", slot, value: expression(value.args[1], child) },
            ],
          },
        ];
      if (slot !== undefined && value.operator === "\\in")
        return [
          {
            name,
            steps: [
              {
                kind: "choose",
                slot,
                domain: domain(value.args[1], child, true),
              },
            ],
          },
        ];
      const reverse = target(value.args[1], context);
      if (reverse !== undefined && value.operator === "=")
        return [
          {
            name,
            steps: [
              {
                kind: "assign",
                slot: reverse,
                value: expression(value.args[0], child),
              },
            ],
          },
        ];
    }
    return [
      {
        name,
        steps: [{ kind: "guard", expression: expression(value, context) }],
      },
    ];
  };
  const operator = (name: string, phase: Context["phase"]) =>
    call(name, [], { phase, locals: new Map(), calls: [], depth: 0 });
  const initName = config.init ?? unsupported("INIT is required");
  const nextName = config.next ?? unsupported("NEXT is required");
  const initial = operator(initName, "initial");
  const next = operator(nextName, "next");
  const nextBranches = action(next.body, next.context, nextName);
  if (
    !nextBranches.some((branch) =>
      branch.steps.some(
        (step) => step.kind !== "guard" || getLevel(step.expression) > 0,
      ),
    )
  )
    unsupported("NEXT cannot be constant");
  return {
    format: "modelt.safety-program",
    version: 1,
    name: module.name,
    variables,
    initial: action(initial.body, initial.context, initName),
    next: nextBranches,
    invariants: config.invariants.map((name) => {
      const predicate = operator(name, "state");
      return {
        name,
        expression: expression(predicate.body, predicate.context),
      };
    }),
    assumptions: module.assumptions.map((assumption, index) => ({
      name: assumption.name ?? `ASSUME ${index + 1}`,
      expression: expression(assumption.expression, {
        phase: "constant",
        locals: new Map(),
        calls: [],
        depth: 0,
      }),
    })),
    checkDeadlock: config.checkDeadlock,
  };
};
