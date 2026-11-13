import type { PortableTrace, PortableValue } from "./contracts.js";
import { isRecord } from "./trace.js";

export class PortableCoreError extends Error {
  override readonly name = "PortableCoreError";
  constructor(
    readonly code: "value" | "protocol",
    message: string,
  ) {
    super(message);
  }
}

const compareUtf8 = (left: string, right: string): number => {
  const encoder = new TextEncoder();
  const first = encoder.encode(left);
  const second = encoder.encode(right);
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return first.length - second.length;
};

const scalarString = (value: unknown): string => {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value))
    throw new PortableCoreError("value", "Expected a Unicode scalar string");
  return value;
};

export const normalizePortableValue = (value: unknown): PortableValue => {
  const ancestors = new Set<object>();
  const visit = (current: unknown): PortableValue => {
    if (!isRecord(current) || ancestors.has(current))
      throw new PortableCoreError("value", "Expected an acyclic tagged value");
    const fields = current.type === "null" ? ["type"] : ["type", "value"];
    if (
      Object.keys(current).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(current, field))
    )
      throw new PortableCoreError("value", "Unexpected value fields");
    ancestors.add(current);
    try {
      switch (current.type) {
        case "null":
          return { type: "null" };
        case "bool":
          if (typeof current.value === "boolean")
            return { type: "bool", value: current.value };
          break;
        case "int":
          if (
            typeof current.value === "string" &&
            /^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(current.value)
          )
            return { type: "int", value: current.value };
          break;
        case "string":
          return { type: "string", value: scalarString(current.value) };
        case "bytes":
          if (
            typeof current.value === "string" &&
            /^(?:[0-9a-f]{2})*$/.test(current.value)
          )
            return { type: "bytes", value: current.value };
          break;
        case "list":
        case "set": {
          if (!Array.isArray(current.value)) break;
          const values = current.value.map((entry: unknown) => visit(entry));
          if (current.type === "list") return { type: "list", value: values };
          const unique = new Map(
            values.map((entry) => [JSON.stringify(entry), entry]),
          );
          return {
            type: "set",
            value: [...unique]
              .sort((left, right) => compareUtf8(left[0], right[0]))
              .map((entry) => entry[1]),
          };
        }
        case "record": {
          if (!Array.isArray(current.value)) break;
          const fields = current.value
            .map((entry: unknown): readonly [string, PortableValue] => {
              if (!Array.isArray(entry) || entry.length !== 2)
                throw new PortableCoreError("value", "Expected a record pair");
              return [scalarString(entry[0]), visit(entry[1])];
            })
            .sort((left, right) => compareUtf8(left[0], right[0]));
          if (new Set(fields.map((entry) => entry[0])).size !== fields.length)
            throw new PortableCoreError("value", "Duplicate record field");
          return { type: "record", value: fields };
        }
        case "map": {
          if (!Array.isArray(current.value)) break;
          const entries = current.value
            .map((entry: unknown): readonly [PortableValue, PortableValue] => {
              if (!Array.isArray(entry) || entry.length !== 2)
                throw new PortableCoreError("value", "Expected a map pair");
              return [visit(entry[0]), visit(entry[1])];
            })
            .sort((left, right) =>
              compareUtf8(JSON.stringify(left[0]), JSON.stringify(right[0])),
            );
          if (
            new Set(entries.map((entry) => JSON.stringify(entry[0]))).size !==
            entries.length
          )
            throw new PortableCoreError("value", "Duplicate map key");
          return { type: "map", value: entries };
        }
      }
      throw new PortableCoreError("value", "Unsupported portable value");
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value);
};

export const toPortableValue = (value: unknown): PortableValue => {
  const ancestors = new Set<object>();
  const visit = (current: unknown): PortableValue => {
    if (current === null) return { type: "null" };
    if (typeof current === "boolean") return { type: "bool", value: current };
    if (typeof current === "string")
      return { type: "string", value: scalarString(current) };
    if (typeof current === "bigint")
      return { type: "int", value: String(current) };
    if (typeof current === "number" && Number.isSafeInteger(current))
      return { type: "int", value: String(current) };
    if (typeof current !== "object" || ancestors.has(current))
      throw new PortableCoreError("value", "Unsupported or cyclic host value");
    ancestors.add(current);
    try {
      if (current instanceof Uint8Array)
        return {
          type: "bytes",
          value: Array.from(current, (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        };
      if (Array.isArray(current))
        return { type: "list", value: Array.from(current, visit) };
      if (current instanceof Set)
        return { type: "set", value: Array.from(current, visit) };
      if (current instanceof Map)
        return {
          type: "map",
          value: Array.from(
            current,
            (entry) => [visit(entry[0]), visit(entry[1])] as const,
          ),
        };
      if (
        Object.getPrototypeOf(current) === Object.prototype ||
        Object.getPrototypeOf(current) === null
      )
        return {
          type: "record",
          value: Object.entries(current).map(
            (entry) => [scalarString(entry[0]), visit(entry[1])] as const,
          ),
        };
      throw new PortableCoreError(
        "value",
        "Expected a plain record or supported collection",
      );
    } finally {
      ancestors.delete(current);
    }
  };
  return normalizePortableValue(visit(value));
};

export const fromPortableValue = (value: PortableValue): unknown => {
  const visit = (current: PortableValue): unknown => {
    switch (current.type) {
      case "null":
        return null;
      case "bool":
      case "string":
        return current.value;
      case "int":
        return BigInt(current.value) >= BigInt(Number.MIN_SAFE_INTEGER) &&
          BigInt(current.value) <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(current.value)
          : BigInt(current.value);
      case "bytes":
        return Uint8Array.from(current.value.match(/../g) ?? [], (byte) =>
          Number.parseInt(byte, 16),
        );
      case "list":
        return current.value.map(visit);
      case "set":
        return new Set(current.value.map(visit));
      case "record":
        return Object.fromEntries(
          current.value.map((entry) => [entry[0], visit(entry[1])]),
        );
      case "map":
        return new Map(
          current.value.map((entry) => [visit(entry[0]), visit(entry[1])]),
        );
    }
  };
  return visit(normalizePortableValue(value));
};

export const parsePortableTrace = (value: unknown): PortableTrace => {
  if (
    !isRecord(value) ||
    value.format !== "modelt.portable-trace" ||
    value.version !== 1 ||
    typeof value.model !== "string" ||
    !Array.isArray(value.steps) ||
    Object.keys(value).length !== 5
  )
    throw new PortableCoreError("protocol", "Invalid portable trace header");
  return {
    format: "modelt.portable-trace",
    version: 1,
    model: scalarString(value.model),
    initial: normalizePortableValue(value.initial),
    steps: value.steps.map((step: unknown) => {
      if (!isRecord(step) || Object.keys(step).length !== 2)
        throw new PortableCoreError("protocol", "Invalid portable trace step");
      return {
        action: normalizePortableValue(step.action),
        observation: normalizePortableValue(step.observation),
      };
    }),
  };
};

export const encodePortableTrace = (trace: PortableTrace): string =>
  JSON.stringify(parsePortableTrace(trace));
export const decodePortableTrace = (text: string): PortableTrace =>
  parsePortableTrace(JSON.parse(text));
