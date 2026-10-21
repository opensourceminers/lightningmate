import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Checks GraphQL documents — and the variables sent with them — against an
 * introspection dump, without a GraphQL library.
 *
 * Every Amboss Magma call this app makes is a hand-written GraphQL string. A
 * field that does not exist (or was renamed) only shows up at runtime, as an
 * error from Amboss — that is how the generic buy query shipped asking for a
 * field the schema never had. Here every document is parsed and every field,
 * argument, enum value and input field is looked up in the schema saved from
 * magma.amboss.tech (server/test/fixtures/magma-schema.json, re-fetched
 * 2026-10-20). Deprecated fields count as errors: they are what the move to
 * the Magma API is getting away from.
 *
 * Supported subset (all this app uses): one named or anonymous query/mutation,
 * variable definitions, aliases, arguments with variable or literal values
 * (strings, numbers, booleans, null, enums, lists, objects), nested selection
 * sets. No fragments, directives or subscriptions.
 */

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}
interface InputValue {
  name: string;
  type: TypeRef;
  defaultValue: string | null;
}
interface Field {
  name: string;
  args: InputValue[];
  type: TypeRef;
  isDeprecated: boolean;
}
interface SchemaType {
  kind: string;
  name: string;
  fields: Field[] | null;
  inputFields: InputValue[] | null;
  enumValues: { name: string }[] | null;
}

export interface GraphqlSchema {
  queryType: string;
  mutationType: string;
  types: Map<string, SchemaType>;
}

const FIXTURE = fileURLToPath(new URL("../fixtures/magma-schema.json", import.meta.url));
/** api.amboss.space — public market data only (getOffers, getNode,
 *  getMarketMetrics), introspected 2026-10-20. */
const SPACE_FIXTURE = fileURLToPath(new URL("../fixtures/amboss-space-schema.json", import.meta.url));

const cached = new Map<string, GraphqlSchema>();

function loadSchema(file: string): GraphqlSchema {
  const hit = cached.get(file);
  if (hit) return hit;
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    data: { __schema: { queryType: { name: string }; mutationType: { name: string }; types: SchemaType[] } };
  };
  const s = raw.data.__schema;
  const schema = {
    queryType: s.queryType.name,
    mutationType: s.mutationType.name,
    types: new Map(s.types.map((t) => [t.name, t])),
  };
  cached.set(file, schema);
  return schema;
}

/** The Magma API schema (magma.amboss.tech), from the repo fixture. */
export function magmaSchema(): GraphqlSchema {
  return loadSchema(FIXTURE);
}

/** The legacy api.amboss.space schema, from the repo fixture: the public
 *  market data this app still reads there. */
export function ambossSpaceSchema(): GraphqlSchema {
  return loadSchema(SPACE_FIXTURE);
}

// ── parsing ───────────────────────────────────────────────────────────────────

type Token = { kind: "punct" | "name" | "string" | "number" | "variable"; value: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s|,/.test(c)) {
      i++;
    } else if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if ("{}():![]=".includes(c)) {
      out.push({ kind: "punct", value: c });
      i++;
    } else if (c === "$") {
      const m = /^\$([_A-Za-z][_0-9A-Za-z]*)/.exec(src.slice(i));
      if (!m) throw new Error(`bad variable at ${i}`);
      out.push({ kind: "variable", value: m[1] });
      i += m[0].length;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j++;
        s += src[j];
        j++;
      }
      out.push({ kind: "string", value: s });
      i = j + 1;
    } else if (/[-0-9]/.test(c)) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new Error(`bad number at ${i}`);
      out.push({ kind: "number", value: m[0] });
      i += m[0].length;
    } else if (/[_A-Za-z]/.test(c)) {
      const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
      out.push({ kind: "name", value: m![0] });
      i += m![0].length;
    } else if (src.startsWith("...", i)) {
      throw new Error("fragments are not supported by this checker");
    } else {
      throw new Error(`unexpected character "${c}" at ${i}`);
    }
  }
  return out;
}

type TypeNode = { list: TypeNode | null; name: string | null; nonNull: boolean };
type ValueNode =
  | { kind: "variable"; name: string }
  | { kind: "int" | "float" | "string" | "boolean" | "null" | "enum"; value: string }
  | { kind: "list"; values: ValueNode[] }
  | { kind: "object"; fields: { name: string; value: ValueNode }[] };
interface SelectionNode {
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}
export interface OperationNode {
  operation: "query" | "mutation";
  name: string | null;
  variables: { name: string; type: TypeNode; hasDefault: boolean }[];
  selections: SelectionNode[];
}

class Parser {
  private i = 0;
  constructor(private readonly t: Token[]) {}

  private peek(): Token | undefined {
    return this.t[this.i];
  }
  private next(): Token {
    const tok = this.t[this.i++];
    if (!tok) throw new Error("unexpected end of document");
    return tok;
  }
  private expect(value: string): void {
    const tok = this.next();
    if (tok.value !== value || (tok.kind !== "punct" && tok.kind !== "name")) {
      throw new Error(`expected "${value}", got "${tok.value}"`);
    }
  }
  private isPunct(value: string): boolean {
    const tok = this.peek();
    return tok?.kind === "punct" && tok.value === value;
  }

  document(): OperationNode {
    let operation: "query" | "mutation" = "query";
    let name: string | null = null;
    let variables: OperationNode["variables"] = [];
    const first = this.peek();
    if (first?.kind === "name") {
      if (first.value !== "query" && first.value !== "mutation") {
        throw new Error(`only query and mutation operations are supported, got "${first.value}"`);
      }
      operation = first.value;
      this.next();
      if (this.peek()?.kind === "name") name = this.next().value;
      if (this.isPunct("(")) variables = this.variableDefinitions();
    }
    const selections = this.selectionSet();
    if (this.peek()) throw new Error("only one operation per document is supported");
    return { operation, name, variables, selections };
  }

  private variableDefinitions(): OperationNode["variables"] {
    this.expect("(");
    const out: OperationNode["variables"] = [];
    while (!this.isPunct(")")) {
      const v = this.next();
      if (v.kind !== "variable") throw new Error(`expected a variable, got "${v.value}"`);
      this.expect(":");
      const type = this.typeRef();
      let hasDefault = false;
      if (this.isPunct("=")) {
        this.next();
        this.value();
        hasDefault = true;
      }
      out.push({ name: v.value, type, hasDefault });
    }
    this.expect(")");
    return out;
  }

  private typeRef(): TypeNode {
    let node: TypeNode;
    if (this.isPunct("[")) {
      this.next();
      const inner = this.typeRef();
      this.expect("]");
      node = { list: inner, name: null, nonNull: false };
    } else {
      const n = this.next();
      if (n.kind !== "name") throw new Error(`expected a type name, got "${n.value}"`);
      node = { list: null, name: n.value, nonNull: false };
    }
    if (this.isPunct("!")) {
      this.next();
      node.nonNull = true;
    }
    return node;
  }

  private selectionSet(): SelectionNode[] {
    this.expect("{");
    const out: SelectionNode[] = [];
    while (!this.isPunct("}")) out.push(this.selection());
    this.expect("}");
    if (out.length === 0) throw new Error("empty selection set");
    return out;
  }

  private selection(): SelectionNode {
    const first = this.next();
    if (first.kind !== "name") throw new Error(`expected a field name, got "${first.value}"`);
    let name = first.value;
    if (this.isPunct(":")) {
      // alias: field
      this.next();
      const real = this.next();
      if (real.kind !== "name") throw new Error(`expected a field name after alias "${name}"`);
      name = real.value;
    }
    const args: SelectionNode["args"] = [];
    if (this.isPunct("(")) {
      this.next();
      while (!this.isPunct(")")) {
        const a = this.next();
        if (a.kind !== "name") throw new Error(`expected an argument name, got "${a.value}"`);
        this.expect(":");
        args.push({ name: a.value, value: this.value() });
      }
      this.expect(")");
    }
    const selections = this.isPunct("{") ? this.selectionSet() : null;
    return { name, args, selections };
  }

  private value(): ValueNode {
    const tok = this.next();
    if (tok.kind === "variable") return { kind: "variable", name: tok.value };
    if (tok.kind === "string") return { kind: "string", value: tok.value };
    if (tok.kind === "number") return { kind: /[.eE]/.test(tok.value) ? "float" : "int", value: tok.value };
    if (tok.kind === "name") {
      if (tok.value === "true" || tok.value === "false") return { kind: "boolean", value: tok.value };
      if (tok.value === "null") return { kind: "null", value: "null" };
      return { kind: "enum", value: tok.value };
    }
    if (tok.value === "[") {
      const values: ValueNode[] = [];
      while (!this.isPunct("]")) values.push(this.value());
      this.expect("]");
      return { kind: "list", values };
    }
    if (tok.value === "{") {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct("}")) {
        const n = this.next();
        if (n.kind !== "name") throw new Error(`expected an input field name, got "${n.value}"`);
        this.expect(":");
        fields.push({ name: n.value, value: this.value() });
      }
      this.expect("}");
      return { kind: "object", fields };
    }
    throw new Error(`unexpected "${tok.value}" where a value belongs`);
  }
}

export function parseOperation(doc: string): OperationNode {
  return new Parser(tokenize(doc)).document();
}

// ── validation ────────────────────────────────────────────────────────────────

const named = (t: TypeRef): string => (t.ofType ? named(t.ofType) : (t.name as string));
const show = (t: TypeRef): string =>
  t.kind === "NON_NULL" ? `${show(t.ofType!)}!` : t.kind === "LIST" ? `[${show(t.ofType!)}]` : (t.name as string);
const showNode = (t: TypeNode): string => (t.list ? `[${showNode(t.list)}]` : (t.name as string)) + (t.nonNull ? "!" : "");

/** Same type, where a non-null variable may feed a nullable argument. */
function compatible(variable: TypeNode, expected: TypeRef): boolean {
  if (expected.kind === "NON_NULL") {
    return variable.nonNull && compatible({ ...variable, nonNull: false }, expected.ofType!);
  }
  if (variable.nonNull) return compatible({ ...variable, nonNull: false }, expected);
  if (expected.kind === "LIST") return variable.list !== null && compatible(variable.list, expected.ofType!);
  return variable.list === null && variable.name === expected.name;
}

/**
 * Every problem with `doc` against `schema` (empty = valid): unknown or
 * deprecated fields, unknown or missing arguments, wrong leaf/object
 * selections, undeclared, unused or mistyped variables, bad literals.
 */
export function checkDocument(schema: GraphqlSchema, doc: string): string[] {
  const errors: string[] = [];
  let op: OperationNode;
  try {
    op = parseOperation(doc);
  } catch (e) {
    return [`does not parse: ${e instanceof Error ? e.message : String(e)}`];
  }
  const declared = new Map(op.variables.map((v) => [v.name, v]));
  const used = new Set<string>();
  for (const v of op.variables) {
    const t = schema.types.get(nameOfNode(v.type));
    if (!t) errors.push(`$${v.name}: unknown type ${showNode(v.type)}`);
    else if (!["SCALAR", "ENUM", "INPUT_OBJECT"].includes(t.kind)) errors.push(`$${v.name}: ${t.name} is not an input type`);
  }

  const checkValue = (where: string, value: ValueNode, expected: TypeRef): void => {
    if (value.kind === "variable") {
      used.add(value.name);
      const v = declared.get(value.name);
      if (!v) errors.push(`${where}: $${value.name} is not declared`);
      else if (!compatible(v.type, expected) && !(v.hasDefault && compatible({ ...v.type, nonNull: true }, expected))) {
        errors.push(`${where}: $${value.name} is ${showNode(v.type)}, expected ${show(expected)}`);
      }
      return;
    }
    if (value.kind === "null") {
      if (expected.kind === "NON_NULL") errors.push(`${where}: null for non-null ${show(expected)}`);
      return;
    }
    const inner = expected.kind === "NON_NULL" ? expected.ofType! : expected;
    if (inner.kind === "LIST") {
      const items = value.kind === "list" ? value.values : [value];
      items.forEach((item, i) => checkValue(`${where}[${i}]`, item, inner.ofType!));
      return;
    }
    const t = schema.types.get(inner.name as string);
    if (!t) {
      errors.push(`${where}: unknown type ${inner.name}`);
      return;
    }
    if (t.kind === "ENUM") {
      if (value.kind !== "enum" || !t.enumValues?.some((e) => e.name === value.value)) {
        errors.push(`${where}: ${JSON.stringify("value" in value ? value.value : value.kind)} is not a ${t.name}`);
      }
    } else if (t.kind === "INPUT_OBJECT") {
      if (value.kind !== "object") {
        errors.push(`${where}: expected an input object ${t.name}`);
        return;
      }
      const given = new Set(value.fields.map((f) => f.name));
      for (const f of value.fields) {
        const def = t.inputFields?.find((x) => x.name === f.name);
        if (!def) errors.push(`${where}.${f.name}: not a field of ${t.name}`);
        else checkValue(`${where}.${f.name}`, f.value, def.type);
      }
      for (const def of t.inputFields ?? []) {
        if (def.type.kind === "NON_NULL" && def.defaultValue === null && !given.has(def.name)) {
          errors.push(`${where}: missing required ${t.name}.${def.name}`);
        }
      }
    } else if (t.kind === "SCALAR") {
      const ok =
        (t.name === "String" && value.kind === "string") ||
        (t.name === "Boolean" && value.kind === "boolean") ||
        (t.name === "Int" && value.kind === "int") ||
        (t.name === "Float" && (value.kind === "int" || value.kind === "float")) ||
        (t.name === "ID" && (value.kind === "string" || value.kind === "int"));
      if (!ok) errors.push(`${where}: ${value.kind} literal for ${t.name}`);
    }
  };

  const walk = (parentName: string, selections: SelectionNode[], path: string): void => {
    const parent = schema.types.get(parentName);
    if (!parent?.fields) {
      errors.push(`${path}: ${parentName} has no fields`);
      return;
    }
    for (const sel of selections) {
      const at = `${path}.${sel.name}`;
      if (sel.name === "__typename") continue;
      const field = parent.fields.find((f) => f.name === sel.name);
      if (!field) {
        errors.push(`${at}: ${parentName} has no field "${sel.name}"`);
        continue;
      }
      if (field.isDeprecated) errors.push(`${at}: ${parentName}.${sel.name} is deprecated`);
      const passed = new Set(sel.args.map((a) => a.name));
      for (const a of sel.args) {
        const def = field.args.find((x) => x.name === a.name);
        if (!def) errors.push(`${at}(${a.name}): unknown argument`);
        else checkValue(`${at}(${a.name})`, a.value, def.type);
      }
      for (const def of field.args) {
        if (def.type.kind === "NON_NULL" && def.defaultValue === null && !passed.has(def.name)) {
          errors.push(`${at}: missing required argument ${def.name}`);
        }
      }
      const target = schema.types.get(named(field.type));
      const isLeaf = target?.kind === "SCALAR" || target?.kind === "ENUM";
      if (isLeaf && sel.selections) errors.push(`${at}: ${named(field.type)} is a leaf, it takes no selection`);
      if (!isLeaf && !sel.selections) errors.push(`${at}: ${named(field.type)} needs a selection of subfields`);
      if (!isLeaf && sel.selections) walk(named(field.type), sel.selections, at);
    }
  };

  walk(op.operation === "mutation" ? schema.mutationType : schema.queryType, op.selections, op.operation);
  for (const v of op.variables) if (!used.has(v.name)) errors.push(`$${v.name} is declared but never used`);
  return errors;
}

function nameOfNode(t: TypeNode): string {
  return t.list ? nameOfNode(t.list) : (t.name as string);
}

/**
 * Problems with the variables actually sent with `doc` (empty = valid):
 * missing required ones, unknown input fields, wrong scalar kinds, bad enum
 * values. This is what catches e.g. a number sent where the schema wants a
 * String, or a required input field the code forgot.
 */
export function checkVariables(schema: GraphqlSchema, doc: string, variables: Record<string, unknown> | undefined): string[] {
  const errors: string[] = [];
  const op = parseOperation(doc);
  const vars = variables ?? {};
  for (const name of Object.keys(vars)) {
    if (!op.variables.some((v) => v.name === name)) errors.push(`$${name} is sent but not declared`);
  }
  const checkNode = (where: string, value: unknown, t: TypeNode): void => {
    if (value === null || value === undefined) {
      if (t.nonNull) errors.push(`${where}: required, got ${value === null ? "null" : "nothing"}`);
      return;
    }
    if (t.list) {
      if (!Array.isArray(value)) errors.push(`${where}: expected a list`);
      else value.forEach((v, i) => checkNode(`${where}[${i}]`, v, t.list as TypeNode));
      return;
    }
    checkNamed(where, value, t.name as string);
  };
  const checkRef = (where: string, value: unknown, t: TypeRef): void => {
    if (value === null || value === undefined) {
      if (t.kind === "NON_NULL") errors.push(`${where}: required, got ${value === null ? "null" : "nothing"}`);
      return;
    }
    const inner = t.kind === "NON_NULL" ? t.ofType! : t;
    if (inner.kind === "LIST") {
      if (!Array.isArray(value)) errors.push(`${where}: expected a list`);
      else value.forEach((v, i) => checkRef(`${where}[${i}]`, v, inner.ofType!));
      return;
    }
    checkNamed(where, value, inner.name as string);
  };
  const checkNamed = (where: string, value: unknown, typeName: string): void => {
    const t = schema.types.get(typeName);
    if (!t) {
      errors.push(`${where}: unknown type ${typeName}`);
      return;
    }
    if (t.kind === "SCALAR") {
      const ok =
        (t.name === "String" && typeof value === "string") ||
        (t.name === "Boolean" && typeof value === "boolean") ||
        (t.name === "Int" && Number.isInteger(value)) ||
        (t.name === "Float" && typeof value === "number" && Number.isFinite(value)) ||
        (t.name === "ID" && (typeof value === "string" || Number.isInteger(value)));
      if (!ok) errors.push(`${where}: ${JSON.stringify(value)} is not a ${t.name}`);
    } else if (t.kind === "ENUM") {
      if (typeof value !== "string" || !t.enumValues?.some((e) => e.name === value)) {
        errors.push(`${where}: ${JSON.stringify(value)} is not a ${t.name}`);
      }
    } else if (t.kind === "INPUT_OBJECT") {
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${where}: expected an input object ${t.name}`);
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (!t.inputFields?.some((f) => f.name === k)) errors.push(`${where}.${k}: not a field of ${t.name}`);
      }
      for (const f of t.inputFields ?? []) checkRef(`${where}.${f.name}`, obj[f.name], f.type);
    } else {
      errors.push(`${where}: ${t.name} is not an input type`);
    }
  };
  for (const v of op.variables) checkNode(`$${v.name}`, vars[v.name], v.hasDefault ? { ...v.type, nonNull: false } : v.type);
  return errors;
}
