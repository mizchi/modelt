import {
  type ConfigValue,
  type Module,
  parseConfig,
  parseModule,
} from "tla-ts";
import type {
  SafetyBinding,
  SafetyBranch,
  SafetyDomain,
  SafetyExpression,
  SafetyPredicate,
  SafetyProgram,
  SafetyStep,
  TemporalFormula,
} from "./contracts.js";
import { PortableCoreError } from "./portable-value.js";

type Expression = Module["definitions"][number]["body"];
type Definition = Module["definitions"][number];
type Bound = Extract<
  Expression,
  { kind: "Forall" | "Exists" }
>["bounds"][number];
interface Scope {
  readonly entries: Map<
    string,
    {
      readonly definition: Definition;
      readonly locals: ReadonlyMap<string, SafetyExpression>;
      readonly scope: Scope;
    }
  >;
}
interface Context {
  readonly phase: "initial" | "next" | "state" | "constant";
  readonly locals: ReadonlyMap<string, SafetyExpression>;
  readonly calls: readonly string[];
  readonly depth: number;
  readonly bound: number;
  readonly scope: Scope;
}
const getLevel = (value: unknown): number => {
  if (typeof value !== "object" || value === null) return 0;
  if ("op" in value && value.op === "read" && "next" in value)
    return value.next ? 2 : 1;
  if ("op" in value && value.op === "prime") return 2;
  if ("op" in value && value.op === "enabled") return 1;
  return Object.values(value).reduce<number>(
    (level, entry: unknown) => Math.max(level, getLevel(entry)),
    0,
  );
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
      `Unsupported TLA input: ${message}`,
    );
  };
  if (
    module.modules.length ||
    module.instances.length ||
    module.extends.some(
      (name) =>
        !["Naturals", "Integers", "Sequences", "FiniteSets"].includes(name),
    )
  )
    unsupported("modules or EXTENDS");
  if (
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
    unsupported("constrained configuration");
  if (
    config.specification
      ? config.init || config.next
      : !config.init || !config.next
  )
    unsupported("use SPECIFICATION or INIT / NEXT");
  const variables = module.variables.map((value) => value.name);
  if (
    !variables.length ||
    variables.length > 256 ||
    new Set(variables).size !== variables.length ||
    module.variables.some((value) => value.arity !== 0)
  )
    unsupported("state variables");
  const slots = new Map(variables.map((name, index) => [name, index]));
  const scope: Scope = { entries: new Map() };
  const symbols = [
    ...variables,
    ...module.constants.map((value) => value.name),
    ...module.definitions.map((value) => value.name),
  ];
  if (
    new Set(symbols).size !== symbols.length ||
    module.definitions.some(
      (definition) =>
        definition.kind === "Operator" &&
        (definition.params.some((param) => symbols.includes(param.name)) ||
          new Set(definition.params.map((param) => param.name)).size !==
            definition.params.length),
    )
  )
    unsupported("conflicting symbols");
  for (const definition of module.definitions)
    scope.entries.set(definition.name, {
      definition,
      locals: new Map(),
      scope,
    });
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
    if (value.kind === "String")
      return { op: "data", value: { type: "string", value: value.value } };
    if (value.kind === "Set")
      return { op: "set", values: value.elements.map(literal) };
    return unsupported(
      "literal (integers must fit signed 32 bits; model values are not strings)",
    );
  };
  const bool = (value: boolean) => literal({ kind: "Boolean", value });
  const string = (value: string): SafetyExpression => ({
    op: "data",
    value: { type: "string", value },
  });
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
    const entry = context.scope.entries.get(name);
    const definition = entry?.definition;
    if (
      !entry ||
      !definition ||
      definition.isRecursive ||
      context.calls.includes(name)
    )
      return unsupported(`operator ${name}`);
    const locals = new Map(entry.locals);
    if (definition.kind === "Operator") {
      if (
        definition.params.length !== args.length ||
        definition.params.some((param) => param.arity !== 0)
      )
        return unsupported(`operator ${name}`);
      for (const [index, param] of definition.params.entries()) {
        const argument = args[index];
        if (!argument) return unsupported(`operator argument ${name}`);
        locals.set(param.name, expression(argument, context));
      }
    } else if (args.length) return unsupported(`function operator ${name}`);
    return {
      body:
        definition.kind === "Operator"
          ? definition.body
          : ({
              kind: "FunctionConstruction",
              bounds: definition.bounds,
              body: definition.body,
              location: definition.location,
            } satisfies Expression),
      context: {
        ...nested(context),
        locals,
        scope: entry.scope,
        calls: [...context.calls, name],
      },
    };
  };
  const letContext = (
    value: Extract<Expression, { kind: "Let" }>,
    context: Context,
  ): Context => {
    if (value.instances?.length) return unsupported("LET INSTANCE");
    const childScope: Scope = { entries: new Map(context.scope.entries) };
    if (
      new Set(value.definitions.map((definition) => definition.name)).size !==
      value.definitions.length
    )
      return unsupported("duplicate LET definitions");
    for (const definition of value.definitions)
      childScope.entries.set(definition.name, {
        definition,
        locals: context.locals,
        scope: childScope,
      });
    return { ...nested(context), scope: childScope };
  };
  const bind = (bounds: readonly Bound[], context: Context) => {
    const locals = new Map(context.locals);
    const bindings: SafetyBinding[] = [];
    let child = context;
    for (const bound of bounds) {
      if (child.bound >= 40) return unsupported("more than 40 bound variables");
      const slot = child.bound;
      bindings.push({
        slot,
        domain: domain(bound.set, context, true),
        ...(bound.pattern.kind === "Tuple"
          ? { tupleSize: bound.pattern.names.length }
          : {}),
      });
      if (bound.pattern.kind === "Name")
        locals.set(bound.pattern.name, { op: "bound", slot });
      else
        for (const [index, name] of bound.pattern.names.entries())
          locals.set(name, {
            op: "at",
            target: { op: "bound", slot },
            key: literal({ kind: "Number", value: index + 1 }),
          });
      child = { ...nested(child), locals: new Map(locals), bound: slot + 1 };
    }
    return { bindings, context: child };
  };
  const hasArithmetic = module.extends.some((name) =>
    ["Naturals", "Integers", "Sequences", "FiniteSets"].includes(name),
  );
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
      if (!hasArithmetic) return unsupported("range requires Naturals");
      return {
        kind: "range",
        lower: expression(value.args[0], nested(context)),
        upper: expression(value.args[1], nested(context)),
      };
    }
    if (value.kind === "Identifier") {
      if (value.name === "BOOLEAN")
        return { kind: "set", values: [bool(false), bool(true)] };
      if (value.name === "Nat" || value.name === "Int") {
        if (
          choice ||
          !hasArithmetic ||
          (value.name === "Int" && !module.extends.includes("Integers"))
        )
          return unsupported("infinite enumeration");
        return {
          kind: "range",
          lower: literal({
            kind: "Number",
            value: value.name === "Nat" ? 0 : -2147483648,
          }),
          upper: literal({ kind: "Number", value: 2147483647 }),
        };
      }
      if (
        context.scope.entries.has(value.name) &&
        !context.locals.has(value.name)
      ) {
        const expanded = call(value.name, [], context);
        return domain(expanded.body, expanded.context, choice);
      }
    }
    return { kind: "value", value: expression(value, context) };
  };
  const binary = new Map<
    string,
    | "add"
    | "sub"
    | "mul"
    | "eq"
    | "ne"
    | "lt"
    | "le"
    | "gt"
    | "ge"
    | "implies"
    | "cup"
    | "cap"
    | "difference"
    | "subset-eq"
    | "concat"
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
    ["\\cup", "cup"],
    ["\\union", "cup"],
    ["\\cap", "cap"],
    ["\\intersect", "cap"],
    ["\\", "difference"],
    ["\\subseteq", "subset-eq"],
    ["\\o", "concat"],
  ]);
  const prime = (value: SafetyExpression): SafetyExpression => {
    if (getLevel(value) > 1)
      return unsupported("prime of an action expression");
    return { op: "prime", argument: value };
  };
  const expression = (
    value: Expression,
    context: Context,
  ): SafetyExpression => {
    const child = nested(context);
    if (
      value.kind === "String" &&
      [...value.value].some(
        (character) => (character.codePointAt(0) ?? 0) > 255,
      )
    )
      return unsupported(
        "TLC 1.7.4 string literal contains a character outside the byte range",
      );
    if (value.kind === "Number" || value.kind === "String")
      return literal(value);
    if (value.kind === "Identifier") {
      const local = context.locals.get(value.name);
      if (local) return local;
      const constant = constants.get(value.name);
      if (constant) return literal(constant);
      if (value.name === "TRUE" || value.name === "FALSE")
        return bool(value.name === "TRUE");
      if (value.name === "BOOLEAN")
        return { op: "set", values: [bool(false), bool(true)] };
      const slot = slots.get(value.name);
      if (slot !== undefined) {
        if (context.phase === "constant")
          return unsupported("variable in constant expression");
        return { op: "read", slot, next: context.phase === "initial" };
      }
      const expanded = call(value.name, [], context);
      return expression(expanded.body, expanded.context);
    }
    if (value.kind === "Let")
      return expression(value.body, letContext(value, context));
    if (value.kind === "Label") return expression(value.body, child);
    if (value.kind === "Prime" && context.phase === "next") {
      const inner = expression(value.expression, child);
      return inner.op === "read" && !inner.next
        ? { ...inner, next: true }
        : prime(inner);
    }
    if (value.kind === "Unchanged" && context.phase === "next") {
      const inner = expression(value.expression, child);
      return { op: "eq", left: inner, right: prime(inner) };
    }
    if (value.kind === "Enabled")
      return {
        op: "enabled",
        branches: action(
          value.expression,
          { ...child, phase: "next" },
          "ENABLED",
        ),
      };
    if (value.kind === "ExceptAt") return { op: "old" };
    if (value.kind === "SetEnumeration" || value.kind === "Tuple")
      return {
        op: value.kind === "Tuple" ? "tuple" : "set",
        values: value.elements.map((entry) => expression(entry, child)),
      };
    if (value.kind === "Record" || value.kind === "RecordSet")
      return {
        op: value.kind === "Record" ? "record" : "record-set",
        fields: value.fields.map((field) => [
          field.name,
          expression(field.value, child),
        ]),
      };
    if (value.kind === "FunctionSet")
      return {
        op: "function-set",
        left: expression(value.domain, child),
        right: expression(value.range, child),
      };
    if (value.kind === "FunctionApplication")
      return {
        op: "at",
        target: expression(value.function, child),
        key:
          value.args.length === 1 && value.args[0]
            ? expression(value.args[0], child)
            : {
                op: "tuple",
                values: value.args.map((argument) =>
                  expression(argument, child),
                ),
              },
      };
    if (value.kind === "FieldAccess")
      return {
        op: "at",
        target: expression(value.record, child),
        key: string(value.field),
      };
    if (value.kind === "Except")
      return {
        op: "update",
        target: expression(value.function, child),
        updates: value.updates.map((update) => ({
          path: update.path.map((part) =>
            part.kind === "Field"
              ? string(part.name)
              : part.args.length === 1 && part.args[0]
                ? expression(part.args[0], child)
                : {
                    op: "tuple",
                    values: part.args.map((argument) =>
                      expression(argument, child),
                    ),
                  },
          ),
          value: expression(update.value, child),
        })),
      };
    if (
      value.kind === "Forall" ||
      value.kind === "Exists" ||
      value.kind === "FunctionConstruction" ||
      value.kind === "SetMap" ||
      value.kind === "SetFilter"
    ) {
      if (value.kind === "FunctionConstruction" && value.isRecursive)
        return unsupported("recursive function");
      const bound = bind(
        value.kind === "SetFilter" ? [value.bound] : value.bounds,
        child,
      );
      return {
        op:
          value.kind === "Forall"
            ? "forall"
            : value.kind === "Exists"
              ? "exists"
              : value.kind === "FunctionConstruction"
                ? "function"
                : value.kind === "SetMap"
                  ? "map-set"
                  : "filter",
        bounds: bound.bindings,
        body: expression(
          value.kind === "SetMap"
            ? value.expression
            : value.kind === "SetFilter"
              ? value.predicate
              : value.body,
          bound.context,
        ),
      };
    }
    if (value.kind === "If")
      return {
        op: "if",
        condition: expression(value.condition, child),
        consequent: expression(value.consequent, child),
        alternative: expression(value.alternative, child),
      };
    if (value.kind === "Case" && value.other)
      return value.arms.reduceRight<SafetyExpression>(
        (alternative, arm) => ({
          op: "if",
          condition: expression(arm.condition, child),
          consequent: expression(arm.body, child),
          alternative,
        }),
        expression(value.other, child),
      );
    if (value.kind === "And" || value.kind === "Or")
      return value.operands.reduce<SafetyExpression>(
        (left, operand) => ({
          op: value.kind === "And" ? "and" : "or",
          left,
          right: expression(operand, child),
        }),
        bool(value.kind === "And"),
      );
    if (value.kind === "BoxAction" || value.kind === "AngleAction") {
      const subscript = expression(value.subscript, child);
      const unchanged: SafetyExpression = {
        op: "eq",
        left: subscript,
        right: prime(subscript),
      };
      return {
        op: value.kind === "BoxAction" ? "or" : "and",
        left: expression(value.action, child),
        right:
          value.kind === "BoxAction"
            ? unchanged
            : { op: "not", argument: unchanged },
      };
    }
    if (value.kind === "Apply") {
      if (context.scope.entries.has(value.operator)) {
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
        ["~", "\\lnot", "-.", "-"].includes(value.operator) &&
        first &&
        value.args.length === 1
      )
        return {
          op: ["~", "\\lnot"].includes(value.operator) ? "not" : "neg",
          argument: expression(first, child),
        };
      const unary = new Map<
        string,
        | "domain"
        | "cardinality"
        | "len"
        | "head"
        | "tail"
        | "powerset"
        | "union"
      >([
        ["DOMAIN", "domain"],
        ["Cardinality", "cardinality"],
        ["Len", "len"],
        ["Head", "head"],
        ["Tail", "tail"],
        ["SUBSET", "powerset"],
        ["UNION", "union"],
      ]);
      const unaryOp = unary.get(value.operator);
      if (unaryOp && first && value.args.length === 1) {
        if (
          ["len", "head", "tail"].includes(unaryOp) &&
          !module.extends.includes("Sequences")
        )
          return unsupported("sequence operator requires Sequences");
        if (unaryOp === "cardinality" && !module.extends.includes("FiniteSets"))
          return unsupported("Cardinality requires FiniteSets");
        return { op: unaryOp, argument: expression(first, child) };
      }
      if (["\\in", "\\notin"].includes(value.operator) && first && second) {
        const membership = getMembership(
          expression(first, child),
          second,
          child,
        );
        return value.operator === "\\notin"
          ? { op: "not", argument: membership }
          : membership;
      }
      if (value.operator === "..") {
        const slot = context.bound;
        return {
          op: "map-set",
          bounds: [{ slot, domain: domain(value, child, true) }],
          body: { op: "bound", slot },
        };
      }
      if (
        value.operator === "Append" &&
        first &&
        second &&
        module.extends.includes("Sequences")
      )
        return {
          op: "append",
          left: expression(first, child),
          right: expression(second, child),
        };
      if (
        value.operator === "SubSeq" &&
        first &&
        second &&
        value.args[2] &&
        module.extends.includes("Sequences")
      )
        return {
          op: "subseq",
          sequence: expression(first, child),
          from: expression(second, child),
          to: expression(value.args[2], child),
        };
      const op = binary.get(value.operator);
      if (
        op &&
        ["add", "sub", "mul", "lt", "le", "gt", "ge"].includes(op) &&
        !hasArithmetic
      )
        return unsupported("arithmetic requires Naturals");
      if (op === "concat" && !module.extends.includes("Sequences"))
        return unsupported("concatenation requires Sequences");
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
  const membershipSet = (
    value: Expression,
    context: Context,
  ): SafetyExpression => {
    if (
      value.kind === "Identifier" &&
      context.scope.entries.has(value.name) &&
      !context.locals.has(value.name)
    ) {
      const expanded = call(value.name, [], context);
      return membershipSet(expanded.body, expanded.context);
    }
    if (
      value.kind === "Apply" &&
      value.operator === "Seq" &&
      value.args[0] &&
      module.extends.includes("Sequences")
    )
      return {
        op: "sequence-set",
        argument: membershipSet(value.args[0], nested(context)),
      };
    if (value.kind === "FunctionSet")
      return {
        op: "function-set",
        left: expression(value.domain, nested(context)),
        right: membershipSet(value.range, nested(context)),
      };
    if (value.kind === "RecordSet")
      return {
        op: "record-set",
        fields: value.fields.map((field) => [
          field.name,
          membershipSet(field.value, nested(context)),
        ]),
      };
    return expression(value, context);
  };
  const getMembership = (
    left: SafetyExpression,
    value: Expression,
    context: Context,
  ): SafetyExpression => {
    if (
      value.kind === "Identifier" &&
      context.scope.entries.has(value.name) &&
      !context.locals.has(value.name)
    ) {
      const expanded = call(value.name, [], context);
      return getMembership(left, expanded.body, expanded.context);
    }
    if (
      value.kind === "Apply" &&
      value.operator === "Seq" &&
      value.args[0] &&
      module.extends.includes("Sequences")
    )
      return {
        op: "sequence-in",
        left,
        right: membershipSet(value.args[0], nested(context)),
      };
    if (value.kind === "RecordSet" || value.kind === "FunctionSet")
      return {
        op: "function-in",
        left,
        right: membershipSet(value, nested(context)),
      };
    if (value.kind === "Apply" && value.operator === "SUBSET" && value.args[0])
      return {
        op: "subset-eq",
        left,
        right: expression(value.args[0], context),
      };
    return { op: "in", value: left, domain: domain(value, context) };
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
  const unchangedSteps = (value: SafetyExpression): readonly SafetyStep[] => {
    if (value.op === "tuple") return value.values.flatMap(unchangedSteps);
    if (value.op !== "read" || value.next)
      return unsupported("generative UNCHANGED requires state variables");
    return [{ kind: "assign", slot: value.slot, value }];
  };
  const action = (
    value: Expression,
    context: Context,
    name: string,
  ): readonly SafetyBranch[] => {
    const child = nested(context);
    if (
      (value.kind === "Identifier" && context.scope.entries.has(value.name)) ||
      (value.kind === "Apply" && context.scope.entries.has(value.operator))
    ) {
      const name = value.kind === "Identifier" ? value.name : value.operator;
      const expanded = call(
        name,
        value.kind === "Apply" ? value.args : [],
        context,
      );
      return action(expanded.body, expanded.context, name);
    }
    if (value.kind === "Let")
      return action(value.body, letContext(value, context), name);
    if (value.kind === "Label") return action(value.body, child, name);
    if (value.kind === "Exists") {
      const bound = bind(value.bounds, child);
      return limited(
        action(value.body, bound.context, name).map((branch) => ({
          ...branch,
          steps: [
            ...bound.bindings.map(
              (binding) => ({ kind: "bind", ...binding }) satisfies SafetyStep,
            ),
            ...branch.steps,
          ],
        })),
      );
    }
    if (value.kind === "Or")
      return limited(
        value.operands.flatMap((operand) => action(operand, child, name)),
      );
    if (value.kind === "And")
      return value.operands.reduce<readonly SafetyBranch[]>(
        (branches, operand) =>
          limited(
            branches.flatMap((branch) =>
              action(
                operand,
                {
                  ...child,
                  bound:
                    context.bound +
                    branch.steps.filter((step) => step.kind === "bind").length,
                },
                name,
              ).map((addition) => ({
                name: addition.name,
                steps: [...branch.steps, ...addition.steps],
              })),
            ),
          ),
        [{ name, steps: [] }],
      );
    if (value.kind === "If") {
      const condition = expression(value.condition, child);
      return limited([
        ...action(value.consequent, child, name).map((branch) => ({
          ...branch,
          steps: [
            { kind: "guard", expression: condition } satisfies SafetyStep,
            ...branch.steps,
          ],
        })),
        ...action(value.alternative, child, name).map((branch) => ({
          ...branch,
          steps: [
            {
              kind: "guard",
              expression: { op: "not", argument: condition },
            } satisfies SafetyStep,
            ...branch.steps,
          ],
        })),
      ]);
    }
    if (value.kind === "Unchanged" && context.phase === "next")
      return [
        { name, steps: unchangedSteps(expression(value.expression, child)) },
      ];
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
  const root = (phase: Context["phase"]): Context => ({
    phase,
    locals: new Map(),
    calls: [],
    depth: 0,
    bound: 0,
    scope,
  });
  const operator = (name: string, phase: Context["phase"]) =>
    call(name, [], root(phase));
  const atom = (expression: SafetyExpression): TemporalFormula => ({
    kind: "atom",
    expression,
  });
  const negate = (formula: TemporalFormula): TemporalFormula =>
    formula.kind === "atom"
      ? atom({ op: "not", argument: formula.expression })
      : { kind: "not", formula };
  const combine = (
    kind: "and" | "or",
    left: TemporalFormula,
    right: TemporalFormula,
  ): TemporalFormula =>
    left.kind === "atom" && right.kind === "atom"
      ? atom({ op: kind, left: left.expression, right: right.expression })
      : { kind, left, right };
  const isBoxedAction = (value: Expression, context: Context): boolean => {
    if (
      value.kind === "Identifier" &&
      context.scope.entries.has(value.name) &&
      !context.locals.has(value.name)
    ) {
      const expanded = call(value.name, [], context);
      return isBoxedAction(expanded.body, expanded.context);
    }
    if (value.kind === "Apply" && context.scope.entries.has(value.operator)) {
      const expanded = call(value.operator, value.args, context);
      return isBoxedAction(expanded.body, expanded.context);
    }
    return value.kind === "BoxAction";
  };
  const temporal = (value: Expression, context: Context): TemporalFormula => {
    const child = nested(context);
    if (
      (value.kind === "Identifier" && context.scope.entries.has(value.name)) ||
      (value.kind === "Apply" && context.scope.entries.has(value.operator))
    ) {
      const expanded = call(
        value.kind === "Identifier" ? value.name : value.operator,
        value.kind === "Apply" ? value.args : [],
        context,
      );
      return temporal(expanded.body, expanded.context);
    }
    if (value.kind === "Let")
      return temporal(value.body, letContext(value, context));
    if (value.kind === "Always" || value.kind === "Eventually") {
      const formula = temporal(value.expression, child);
      if (
        value.kind === "Always" &&
        formula.kind === "atom" &&
        getLevel(formula.expression) > 1 &&
        !isBoxedAction(value.expression, child)
      )
        unsupported("[] action must have the form [A]_v");
      return {
        kind: value.kind === "Always" ? "always" : "eventually",
        formula,
      };
    }
    if (value.kind === "And" || value.kind === "Or")
      return value.operands.reduce<TemporalFormula>(
        (left, operand) =>
          combine(
            value.kind === "And" ? "and" : "or",
            left,
            temporal(operand, child),
          ),
        atom(bool(value.kind === "And")),
      );
    if (value.kind === "Apply" && value.args[0]) {
      if (["~", "\\lnot"].includes(value.operator))
        return negate(temporal(value.args[0], child));
      if (["=>", "~>"].includes(value.operator) && value.args[1]) {
        const right = temporal(value.args[1], child);
        const implication = combine(
          "or",
          negate(temporal(value.args[0], child)),
          value.operator === "~>"
            ? { kind: "eventually", formula: right }
            : right,
        );
        return value.operator === "~>"
          ? { kind: "always", formula: implication }
          : implication;
      }
    }

    if (value.kind === "WeakFairness" || value.kind === "StrongFairness") {
      const subscript = expression(value.subscript, child);
      const enabled = atom({
        op: "enabled",
        branches: action(value.action, child, "fairness"),
        subscript,
      });
      const disabled: TemporalFormula = { kind: "not", formula: enabled };
      const taken = atom({
        op: "and",
        left: expression(value.action, child),
        right: { op: "ne", left: subscript, right: prime(subscript) },
      });
      return value.kind === "WeakFairness"
        ? {
            kind: "always",
            formula: {
              kind: "eventually",
              formula: { kind: "or", left: disabled, right: taken },
            },
          }
        : {
            kind: "or",
            left: {
              kind: "eventually",
              formula: { kind: "always", formula: disabled },
            },
            right: {
              kind: "always",
              formula: { kind: "eventually", formula: taken },
            },
          };
    }
    return atom(expression(value, context));
  };
  const validateTemporalActions = (
    formula: TemporalFormula,
    path: readonly string[] = [],
    direct = formula.kind === "always" && formula.formula.kind === "atom",
  ): void => {
    if (formula.kind === "atom") {
      const tail = path.slice(-2).join(",");
      if (
        getLevel(formula.expression) > 1 &&
        !(direct && path.length === 1) &&
        tail !== "always,eventually" &&
        tail !== "eventually,always"
      )
        unsupported("temporal actions require []<>A or <>[]A");
    } else if (formula.kind === "and" || formula.kind === "or") {
      validateTemporalActions(formula.left, path, direct);
      validateTemporalActions(formula.right, path, direct);
    } else if ("formula" in formula)
      validateTemporalActions(
        formula.formula,
        formula.kind === "not" ? path : [...path, formula.kind],
        direct,
      );
  };
  const fairness: TemporalFormula[] = [];
  let initial: readonly SafetyBranch[] | undefined;
  let next: readonly SafetyBranch[] | undefined;
  if (config.specification) {
    const spec = operator(config.specification, "next");
    const parts = (value: Expression, context: Context): void => {
      if (
        value.kind === "Identifier" &&
        context.scope.entries.has(value.name)
      ) {
        const expanded = call(value.name, [], context);
        parts(expanded.body, expanded.context);
        return;
      }
      if (value.kind === "And") {
        for (const operand of value.operands) parts(operand, nested(context));
        return;
      }
      if (value.kind === "Always" && value.expression.kind === "BoxAction") {
        if (next) unsupported("multiple NEXT conjuncts");
        const subscript = expression(value.expression.subscript, context);
        const reads = (inner: SafetyExpression): number[] =>
          inner.op === "tuple"
            ? inner.values.flatMap(reads)
            : inner.op === "read" && !inner.next
              ? [inner.slot]
              : unsupported(
                  "SPECIFICATION subscript must list state variables",
                );
        if (new Set(reads(subscript)).size !== variables.length)
          unsupported(
            "SPECIFICATION subscript must cover every state variable",
          );
        next = action(value.expression.action, context, "Next");
        return;
      }
      if (value.kind === "WeakFairness" || value.kind === "StrongFairness") {
        fairness.push(temporal(value, context));
        return;
      }
      const additions = action(value, { ...context, phase: "initial" }, "Init");
      initial = initial
        ? limited(
            initial.flatMap((branch) =>
              additions.map((addition) => ({
                name: addition.name,
                steps: [...branch.steps, ...addition.steps],
              })),
            ),
          )
        : additions;
    };
    parts(spec.body, spec.context);
  } else {
    const initialOperator = operator(
      config.init ?? unsupported("INIT"),
      "initial",
    );
    const nextOperator = operator(config.next ?? unsupported("NEXT"), "next");
    initial = action(
      initialOperator.body,
      initialOperator.context,
      config.init ?? "Init",
    );
    next = action(
      nextOperator.body,
      nextOperator.context,
      config.next ?? "Next",
    );
  }
  if (!initial || !next)
    return unsupported("initial predicate and NEXT are required");
  if (
    !next.some((branch) =>
      branch.steps.some(
        (step) => step.kind !== "guard" || getLevel(step.expression) > 0,
      ),
    )
  )
    return unsupported("NEXT cannot be constant");
  const invariants: SafetyPredicate[] = config.invariants.map((name) => {
    const predicate = operator(name, "state");
    return { name, expression: expression(predicate.body, predicate.context) };
  });
  const initialProperties: SafetyPredicate[] = [];
  const actionProperties: SafetyPredicate[] = [];
  const properties: { name: string; formula: TemporalFormula }[] = [];
  for (const name of config.properties) {
    const predicate = operator(name, "next");
    const formula = temporal(predicate.body, predicate.context);
    validateTemporalActions(formula);
    if (formula.kind === "atom") {
      if (getLevel(formula.expression) > 1)
        return unsupported("initial PROPERTY must be a state predicate");
      initialProperties.push({ name, expression: formula.expression });
    } else if (formula.kind === "always" && formula.formula.kind === "atom") {
      const expression = formula.formula.expression;
      (getLevel(expression) > 1 ? actionProperties : invariants).push({
        name,
        expression,
      });
    } else properties.push({ name, formula });
  }
  return {
    format: "modelt.safety-program",
    version: 1,
    name: module.name,
    variables,
    initial,
    next,
    invariants,
    assumptions: module.assumptions.map((assumption, index) => ({
      name: assumption.name ?? `ASSUME ${index + 1}`,
      expression: expression(assumption.expression, root("constant")),
    })),
    checkDeadlock: config.checkDeadlock,
    ...(initialProperties.length ? { initialProperties } : {}),
    ...(actionProperties.length ? { actionProperties } : {}),
    ...(properties.length ? { properties, fairness } : {}),
  };
};
