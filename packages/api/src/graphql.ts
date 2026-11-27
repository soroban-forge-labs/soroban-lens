import {
  MAX_QUERY_LIMIT,
  DEFAULT_QUERY_LIMIT,
  type ContractSummary,
  type EventStore,
  type JsonValue,
} from '@soroban-lens/store';
import { ApiError } from './errors.js';
import { assertContractId, parseEventQuery } from './params.js';

/*
 * An optional, read-only GraphQL endpoint over the same EventStore the REST
 * routes use.
 *
 * Hand-rolled rather than built on `graphql-js`: CONTRIBUTING.md rules out new
 * runtime dependencies without discussion, and the surface here is small — one
 * fixed schema, queries only. What is supported is exactly what the schema
 * below needs: operations, variables, aliases, fragments, inline fragments,
 * @skip/@include and __typename. Mutations, subscriptions and introspection are
 * rejected with a clear message rather than half-implemented.
 *
 * The part that matters most for a public endpoint is the guard against
 * unbounded queries: every document is analysed *before* anything touches the
 * store, and rejected if it is too deep or its estimated cost is too high.
 */

// ── Options ──────────────────────────────────────────────────────────────────

export interface GraphQLOptions {
  /** `/graphql` answers 404 unless this is true. Disabled by default. */
  enabled?: boolean;
  /** Deepest selection nesting allowed; top-level fields are depth 1. Default 8. */
  maxDepth?: number;
  /** Highest estimated cost allowed. See `analyse`. Default 5000. */
  maxComplexity?: number;
  /** Longest accepted query document, in characters. Default 10 000. */
  maxQueryLength?: number;
}

export const DEFAULT_GRAPHQL_MAX_DEPTH = 8;
export const DEFAULT_GRAPHQL_MAX_COMPLEXITY = 5000;
export const DEFAULT_GRAPHQL_MAX_QUERY_LENGTH = 10_000;

/** Error codes in `errors[].extensions.code`. */
export type GraphQLErrorCode =
  | 'GRAPHQL_PARSE_FAILED'
  | 'GRAPHQL_VALIDATION_FAILED'
  | 'BAD_USER_INPUT'
  | 'QUERY_TOO_DEEP'
  | 'QUERY_TOO_COMPLEX'
  | 'QUERY_TOO_LARGE'
  | 'INTERNAL_ERROR';

/** A failure that stops a request before execution, answered with HTTP 400. */
export class GraphQLRequestError extends Error {
  readonly code: GraphQLErrorCode;
  constructor(code: GraphQLErrorCode, message: string) {
    super(message);
    this.name = 'GraphQLRequestError';
    this.code = code;
  }
}

interface ResponseError {
  message: string;
  path?: (string | number)[];
  extensions: { code: GraphQLErrorCode };
}

export interface GraphQLResponse {
  data?: unknown;
  errors?: ResponseError[];
}

export interface GraphQLRequest {
  query: string;
  variables?: unknown;
  operationName?: string | undefined;
}

// ── Lexer ────────────────────────────────────────────────────────────────────

type Token =
  | { kind: 'punct'; value: string; pos: number }
  | { kind: 'name'; value: string; pos: number }
  | { kind: 'int'; value: string; pos: number }
  | { kind: 'float'; value: string; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'eof'; value: ''; pos: number };

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[0-9A-Za-z_]/;

function parseError(message: string, pos: number): GraphQLRequestError {
  return new GraphQLRequestError('GRAPHQL_PARSE_FAILED', `Syntax error at position ${pos}: ${message}`);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;

    // Insignificant: whitespace, commas, BOM and comments.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }

    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...', pos: i });
      i += 3;
      continue;
    }
    if ('!$&()[]{}:=@|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, pos: i });
      i++;
      continue;
    }

    if (NAME_START.test(ch)) {
      const start = i;
      while (i < source.length && NAME_PART.test(source[i] as string)) i++;
      tokens.push({ kind: 'name', value: source.slice(start, i), pos: start });
      continue;
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      if (ch === '-') i++;
      const digitsStart = i;
      while (i < source.length && (source[i] as string) >= '0' && (source[i] as string) <= '9') i++;
      if (i === digitsStart) throw parseError('expected a digit after "-"', start);
      let isFloat = false;
      if (source[i] === '.') {
        isFloat = true;
        i++;
        const fracStart = i;
        while (i < source.length && (source[i] as string) >= '0' && (source[i] as string) <= '9') i++;
        if (i === fracStart) throw parseError('expected digits after "."', start);
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        const expStart = i;
        while (i < source.length && (source[i] as string) >= '0' && (source[i] as string) <= '9') i++;
        if (i === expStart) throw parseError('expected digits in the exponent', start);
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(start, i), pos: start });
      continue;
    }

    if (ch === '"') {
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === '\n' || c === '\r') break;
        if (c === '\\') {
          const next = source[i + 1];
          const simple: Record<string, string> = {
            '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
          };
          if (next !== undefined && next in simple) {
            value += simple[next] as string;
            i += 2;
            continue;
          }
          if (next === 'u') {
            const hex = source.slice(i + 2, i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw parseError('invalid unicode escape', i);
            value += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          throw parseError('invalid escape sequence', i);
        }
        value += c;
        i++;
      }
      if (!closed) throw parseError('unterminated string', start);
      tokens.push({ kind: 'string', value, pos: start });
      continue;
    }

    throw parseError(`unexpected character ${JSON.stringify(ch)}`, i);
  }
  tokens.push({ kind: 'eof', value: '', pos: source.length });
  return tokens;
}

// ── AST and parser ───────────────────────────────────────────────────────────

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int' | 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface DirectiveNode {
  name: string;
  args: Record<string, ValueNode>;
}

interface FieldNode {
  kind: 'field';
  alias: string | undefined;
  name: string;
  args: Record<string, ValueNode>;
  directives: DirectiveNode[];
  selections: SelectionNode[] | null;
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | undefined;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VariableDefinition {
  name: string;
  /** Printed type, e.g. `Int!` or `[String]`. */
  type: string;
  nonNull: boolean;
  defaultValue: ValueNode | undefined;
}

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | undefined;
  variables: VariableDefinition[];
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

/** Parser nesting limit — protects the parser itself, before depth analysis exists. */
const MAX_PARSE_NESTING = 64;

class Parser {
  private pos = 0;
  private nesting = 0;
  constructor(private readonly tokens: Token[]) {}

  private get tok(): Token {
    return this.tokens[this.pos] as Token;
  }

  private isPunct(value: string): boolean {
    return this.tok.kind === 'punct' && this.tok.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw parseError(`expected "${value}"`, this.tok.pos);
    this.pos++;
  }

  private expectName(): string {
    const t = this.tok;
    if (t.kind !== 'name') throw parseError('expected a name', t.pos);
    this.pos++;
    return t.value;
  }

  private enter(): void {
    if (++this.nesting > MAX_PARSE_NESTING) {
      throw new GraphQLRequestError('QUERY_TOO_DEEP', `The document nests deeper than ${MAX_PARSE_NESTING} levels.`);
    }
  }
  private leave(): void {
    this.nesting--;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.tok.kind !== 'eof') {
      if (this.isPunct('{')) {
        operations.push({
          operation: 'query', name: undefined, variables: [], selections: this.parseSelectionSet(),
        });
      } else if (this.tok.kind === 'name' && this.tok.value === 'fragment') {
        this.pos++;
        const name = this.expectName();
        if (name === 'on') throw parseError('"on" is not a valid fragment name', this.tok.pos);
        const on = this.expectName();
        if (on !== 'on') throw parseError('expected "on"', this.tok.pos);
        const typeCondition = this.expectName();
        this.parseDirectives();
        if (fragments.has(name)) {
          throw new GraphQLRequestError('GRAPHQL_VALIDATION_FAILED', `Fragment "${name}" is defined more than once.`);
        }
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else if (
        this.tok.kind === 'name' &&
        (this.tok.value === 'query' || this.tok.value === 'mutation' || this.tok.value === 'subscription')
      ) {
        const operation = this.tok.value as OperationNode['operation'];
        this.pos++;
        const name = this.tok.kind === 'name' ? this.expectName() : undefined;
        const variables = this.isPunct('(') ? this.parseVariableDefinitions() : [];
        this.parseDirectives();
        operations.push({ operation, name, variables, selections: this.parseSelectionSet() });
      } else {
        throw parseError('expected an operation or a fragment', this.tok.pos);
      }
    }
    if (operations.length === 0) {
      throw new GraphQLRequestError('GRAPHQL_PARSE_FAILED', 'The document contains no operation.');
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const defs: VariableDefinition[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const { text, nonNull } = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.isPunct('=')) {
        this.pos++;
        defaultValue = this.parseValue(true);
      }
      this.parseDirectives();
      defs.push({ name, type: text, nonNull, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): { text: string; nonNull: boolean } {
    let text: string;
    if (this.isPunct('[')) {
      this.pos++;
      this.enter();
      text = `[${this.parseType().text}]`;
      this.leave();
      this.expectPunct(']');
    } else {
      text = this.expectName();
    }
    let nonNull = false;
    if (this.isPunct('!')) {
      this.pos++;
      nonNull = true;
      text += '!';
    }
    return { text, nonNull };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    this.enter();
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.tok.kind === 'eof') throw parseError('unexpected end of document, expected "}"', this.tok.pos);
      selections.push(this.parseSelection());
    }
    this.pos++;
    this.leave();
    if (selections.length === 0) throw parseError('a selection set must not be empty', this.tok.pos);
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.pos++;
      if (this.tok.kind === 'name' && this.tok.value !== 'on') {
        const name = this.expectName();
        return { kind: 'spread', name, directives: this.parseDirectives() };
      }
      let typeCondition: string | undefined;
      if (this.tok.kind === 'name' && this.tok.value === 'on') {
        this.pos++;
        typeCondition = this.expectName();
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition, directives, selections: this.parseSelectionSet() };
    }

    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.isPunct(':')) {
      this.pos++;
      alias = first;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : {};
    const directives = this.parseDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      if (name in args) throw parseError(`argument "${name}" is given more than once`, this.tok.pos);
      args[name] = this.parseValue(false);
    }
    this.expectPunct(')');
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.isPunct('@')) {
      this.pos++;
      const name = this.expectName();
      directives.push({ name, args: this.isPunct('(') ? this.parseArguments() : {} });
    }
    return directives;
  }

  private parseValue(isConst: boolean): ValueNode {
    const t = this.tok;
    if (t.kind === 'punct') {
      if (t.value === '$') {
        if (isConst) throw parseError('a default value cannot reference a variable', t.pos);
        this.pos++;
        return { kind: 'variable', name: this.expectName() };
      }
      if (t.value === '[') {
        this.pos++;
        this.enter();
        const items: ValueNode[] = [];
        while (!this.isPunct(']')) {
          if (this.tok.kind === 'eof') throw parseError('unterminated list', this.tok.pos);
          items.push(this.parseValue(isConst));
        }
        this.pos++;
        this.leave();
        return { kind: 'list', items };
      }
      if (t.value === '{') {
        this.pos++;
        this.enter();
        const fields: Record<string, ValueNode> = {};
        while (!this.isPunct('}')) {
          if (this.tok.kind === 'eof') throw parseError('unterminated object', this.tok.pos);
          const name = this.expectName();
          this.expectPunct(':');
          fields[name] = this.parseValue(isConst);
        }
        this.pos++;
        this.leave();
        return { kind: 'object', fields };
      }
      throw parseError(`unexpected "${t.value}"`, t.pos);
    }
    this.pos++;
    switch (t.kind) {
      case 'int':
        return { kind: 'int', value: Number(t.value) };
      case 'float':
        return { kind: 'float', value: Number(t.value) };
      case 'string':
        return { kind: 'string', value: t.value };
      case 'name':
        if (t.value === 'true') return { kind: 'boolean', value: true };
        if (t.value === 'false') return { kind: 'boolean', value: false };
        if (t.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: t.value };
      default:
        throw parseError('expected a value', t.pos);
    }
  }
}

export function parseDocument(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

// ── Schema ───────────────────────────────────────────────────────────────────

interface TypeRef {
  name: string;
  list?: boolean;
  nonNull?: boolean;
  itemNonNull?: boolean;
}

type ArgType = 'String' | 'Int' | 'Boolean' | '[String]' | 'Order';

interface ArgDef {
  type: ArgType;
  required?: boolean;
}

interface ResolverContext {
  store: EventStore;
  /** One lookup of every contract summary per request, shared by `Event.contract`. */
  contracts(): Promise<Map<string, ContractSummary>>;
}

interface FieldDef {
  type: TypeRef;
  args?: Record<string, ArgDef>;
  /**
   * How many items a list field is assumed to return, for cost estimation:
   * a number, `'limit'` (the field's own `limit` argument) or `'parent'`
   * (the page size of the enclosing paginated field).
   */
  size?: number | 'limit' | 'parent';
  /** True when the field returns a page whose `limit` sizes its children. */
  paged?: boolean;
  resolve?: (source: unknown, args: Record<string, unknown>, ctx: ResolverContext) => unknown;
}

interface ObjectDef {
  fields: Record<string, FieldDef>;
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'JSON']);

/** Filters shared by `Query.events` and `Contract.events`. */
const PAGE_ARGS: Record<string, ArgDef> = {
  topics: { type: '[String]' },
  topicTypes: { type: '[String]' },
  fromLedger: { type: 'Int' },
  toLedger: { type: 'Int' },
  fromTime: { type: 'Int' },
  toTime: { type: 'Int' },
  txHash: { type: 'String' },
  typedField: { type: 'String' },
  typedValue: { type: 'String' },
  typedGt: { type: 'String' },
  typedGte: { type: 'String' },
  typedLt: { type: 'String' },
  typedLte: { type: 'String' },
  address: { type: 'String' },
  addressPosition: { type: 'String' },
  search: { type: 'String' },
  successfulOnly: { type: 'Boolean' },
  limit: { type: 'Int' },
  cursor: { type: 'String' },
  order: { type: 'Order' },
};

/**
 * Reuse the REST parameter parser for the filters, so GraphQL and REST can
 * never disagree about what a valid `limit`, `address` or `txHash` is.
 */
function eventQueryFromArgs(args: Record<string, unknown>, contractId?: string) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (key === 'topics') {
      for (const topic of value as (string | null)[]) params.append('topic', topic ?? '*');
    } else if (key === 'topicTypes') {
      for (const type of value as (string | null)[]) params.append('topicType', type ?? '*');
    } else {
      params.set(key, String(value));
    }
  }
  return { ...parseEventQuery(params), ...(contractId ? { contractId } : {}) };
}

const schema: Record<string, ObjectDef> = {
  Query: {
    fields: {
      events: {
        type: { name: 'EventPage', nonNull: true },
        paged: true,
        args: { contractId: { type: 'String' }, ...PAGE_ARGS },
        resolve: (_s, args, { store }) => {
          const { contractId, ...filters } = args;
          const id = typeof contractId === 'string' ? assertContractId(contractId) : undefined;
          return store.queryEvents(eventQueryFromArgs(filters, id));
        },
      },
      event: {
        type: { name: 'Event' },
        args: { id: { type: 'String', required: true } },
        resolve: (_s, args, { store }) => store.getEvent(args['id'] as string),
      },
      contracts: {
        type: { name: 'Contract', list: true, nonNull: true, itemNonNull: true },
        size: 'limit',
        args: { limit: { type: 'Int' } },
        resolve: (_s, args, { store }) => store.listContracts(boundedLimit(args['limit'])),
      },
      contract: {
        type: { name: 'Contract' },
        args: { id: { type: 'String', required: true } },
        resolve: async (_s, args, ctx) =>
          (await ctx.contracts()).get(assertContractId(args['id'] as string)) ?? null,
      },
      topics: {
        type: { name: 'Topic', list: true, nonNull: true, itemNonNull: true },
        size: 'limit',
        args: { contractId: { type: 'String', required: true }, limit: { type: 'Int' } },
        resolve: (_s, args, { store }) =>
          store.listTopics(assertContractId(args['contractId'] as string), { limit: boundedLimit(args['limit']) }),
      },
    },
  },
  EventPage: {
    fields: {
      events: { type: { name: 'Event', list: true, nonNull: true, itemNonNull: true }, size: 'parent' },
      nextCursor: { type: { name: 'String' } },
      total: { type: { name: 'Int', nonNull: true } },
    },
  },
  Event: {
    fields: {
      id: { type: { name: 'String', nonNull: true } },
      contractId: { type: { name: 'String', nonNull: true } },
      type: { type: { name: 'String', nonNull: true } },
      ledger: { type: { name: 'Int', nonNull: true } },
      ledgerClosedAt: { type: { name: 'String', nonNull: true } },
      txHash: { type: { name: 'String', nonNull: true } },
      transactionIndex: { type: { name: 'Int', nonNull: true } },
      operationIndex: { type: { name: 'Int', nonNull: true } },
      inSuccessfulContractCall: { type: { name: 'Boolean', nonNull: true } },
      // Event topics are bounded in practice; 8 is a generous cost estimate.
      topics: { type: { name: 'DecodedValue', list: true, nonNull: true, itemNonNull: true }, size: 8 },
      value: { type: { name: 'DecodedValue', nonNull: true } },
      decodeError: { type: { name: 'String' } },
      indexedAt: { type: { name: 'String', nonNull: true } },
      // The join the REST shape cannot do: an event together with its
      // contract's summary, in one round trip.
      contract: {
        type: { name: 'Contract' },
        resolve: async (source, _args, ctx) =>
          (await ctx.contracts()).get((source as { contractId: string }).contractId) ?? null,
      },
    },
  },
  DecodedValue: {
    fields: {
      type: { type: { name: 'String', nonNull: true } },
      value: { type: { name: 'JSON' } },
    },
  },
  Contract: {
    fields: {
      contractId: { type: { name: 'String', nonNull: true } },
      eventCount: { type: { name: 'Int', nonNull: true } },
      firstLedger: { type: { name: 'Int', nonNull: true } },
      lastLedger: { type: { name: 'Int', nonNull: true } },
      lastSeenAt: { type: { name: 'String', nonNull: true } },
      topics: {
        type: { name: 'Topic', list: true, nonNull: true, itemNonNull: true },
        size: 'limit',
        args: { limit: { type: 'Int' } },
        resolve: (source, args, { store }) =>
          store.listTopics((source as ContractSummary).contractId, { limit: boundedLimit(args['limit']) }),
      },
      events: {
        type: { name: 'EventPage', nonNull: true },
        paged: true,
        args: PAGE_ARGS,
        resolve: (source, args, { store }) =>
          store.queryEvents(eventQueryFromArgs(args, (source as ContractSummary).contractId)),
      },
    },
  },
  Topic: {
    fields: {
      topic: { type: { name: 'String', nonNull: true } },
      count: { type: { name: 'Int', nonNull: true } },
    },
  },
};

function boundedLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const limit = value as number;
  if (limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw ApiError.badRequest(`"limit" must be between 1 and ${MAX_QUERY_LIMIT}, got ${limit}.`, 'limit');
  }
  return limit;
}

// ── Values, arguments and directives ─────────────────────────────────────────

type Variables = Record<string, unknown>;

function valueOf(node: ValueNode, vars: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, vars));
    case 'object':
      return Object.fromEntries(Object.entries(node.fields).map(([k, v]) => [k, valueOf(v, vars)]));
  }
}

function invalid(message: string): GraphQLRequestError {
  return new GraphQLRequestError('GRAPHQL_VALIDATION_FAILED', message);
}

function coerceArg(field: string, name: string, def: ArgDef, raw: unknown): unknown {
  const bad = (expected: string): GraphQLRequestError =>
    new GraphQLRequestError('BAD_USER_INPUT', `Argument "${name}" of "${field}" must be ${expected}.`);
  if (raw === null) {
    if (def.required) throw bad('non-null');
    return null;
  }
  switch (def.type) {
    case 'String':
      if (typeof raw !== 'string') throw bad('a String');
      return raw;
    case 'Int':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw bad('an Int');
      return raw;
    case 'Boolean':
      if (typeof raw !== 'boolean') throw bad('a Boolean');
      return raw;
    case 'Order':
      if (raw !== 'asc' && raw !== 'desc') throw bad('"asc" or "desc"');
      return raw;
    case '[String]': {
      // GraphQL input coercion: a lone value is a one-item list.
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        if (item !== null && typeof item !== 'string') throw bad('a list of Strings');
      }
      return items;
    }
  }
}

/** Validate and coerce a field's arguments; unknown or missing-required ones are errors. */
function resolveArgs(
  typeName: string,
  fieldName: string,
  def: FieldDef,
  node: FieldNode,
  vars: Variables,
): Record<string, unknown> {
  const declared = def.args ?? {};
  const label = `${typeName}.${fieldName}`;
  for (const name of Object.keys(node.args)) {
    if (!(name in declared)) {
      throw invalid(`Unknown argument "${name}" on field "${label}".`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [name, argDef] of Object.entries(declared)) {
    const given = node.args[name];
    const raw = given === undefined ? undefined : valueOf(given, vars);
    if (raw === undefined) {
      if (argDef.required) {
        throw new GraphQLRequestError('BAD_USER_INPUT', `Argument "${name}" of "${label}" is required.`);
      }
      continue;
    }
    out[name] = coerceArg(label, name, argDef, raw);
  }
  return out;
}

/** Evaluate @skip / @include. Returns whether the selection stays. */
function included(directives: DirectiveNode[], vars: Variables): boolean {
  for (const directive of directives) {
    if (directive.name !== 'skip' && directive.name !== 'include') {
      throw invalid(`Unknown directive "@${directive.name}".`);
    }
    const arg = directive.args['if'];
    const value = arg === undefined ? undefined : valueOf(arg, vars);
    if (typeof value !== 'boolean') {
      throw invalid(`Directive "@${directive.name}" requires a Boolean "if" argument.`);
    }
    if (directive.name === 'skip' && value) return false;
    if (directive.name === 'include' && !value) return false;
  }
  return true;
}

// ── Field collection ─────────────────────────────────────────────────────────

interface CollectedField {
  responseKey: string;
  node: FieldNode;
  /** Sub-selections from every merged occurrence of this response key. */
  selections: SelectionNode[];
}

function collectFields(
  doc: DocumentNode,
  typeName: string,
  selections: SelectionNode[],
  vars: Variables,
  into: Map<string, CollectedField> = new Map(),
  visiting: Set<string> = new Set(),
): Map<string, CollectedField> {
  for (const selection of selections) {
    if (!included(selection.directives, vars)) continue;

    if (selection.kind === 'field') {
      const responseKey = selection.alias ?? selection.name;
      const existing = into.get(responseKey);
      if (existing) {
        if (existing.node.name !== selection.name) {
          throw invalid(`Fields "${responseKey}" conflict: "${existing.node.name}" and "${selection.name}".`);
        }
        existing.selections.push(...(selection.selections ?? []));
      } else {
        into.set(responseKey, { responseKey, node: selection, selections: [...(selection.selections ?? [])] });
      }
    } else if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (!fragment) throw invalid(`Unknown fragment "${selection.name}".`);
      if (visiting.has(selection.name)) throw invalid(`Fragment "${selection.name}" spreads itself.`);
      if (fragment.typeCondition !== typeName) continue;
      visiting.add(selection.name);
      collectFields(doc, typeName, fragment.selections, vars, into, visiting);
      visiting.delete(selection.name);
    } else {
      if (selection.typeCondition !== undefined && selection.typeCondition !== typeName) continue;
      collectFields(doc, typeName, selection.selections, vars, into, visiting);
    }
  }
  return into;
}

// ── Static analysis: depth and complexity ────────────────────────────────────

interface Limits {
  maxDepth: number;
  maxComplexity: number;
}

/**
 * Walk the whole document without touching the store, validating every field
 * and argument, and enforce the depth and complexity limits.
 *
 * Cost model: a leaf field costs 1. An object field costs 1 plus its children.
 * A list field costs 1 plus its children *multiplied by how many items it can
 * return* — the field's `limit` argument (the default page size when absent),
 * or for `EventPage.events` the limit of the page it sits in. That makes the
 * nested-pagination blow-up that GraphQL is notorious for show up as a number:
 * `contracts(limit: 100) { events(limit: 100) { events { id } } }` is ~20 000,
 * far past the default ceiling, while a plain page of events costs ~1 000.
 */
function analyse(
  doc: DocumentNode,
  operation: OperationNode,
  vars: Variables,
  limits: Limits,
): number {
  const walk = (
    typeName: string,
    selections: SelectionNode[],
    depth: number,
    pageSize: number,
  ): number => {
    if (depth > limits.maxDepth) {
      throw new GraphQLRequestError(
        'QUERY_TOO_DEEP',
        `Query depth exceeds the maximum of ${limits.maxDepth}.`,
      );
    }
    const objectDef = schema[typeName];
    if (!objectDef) throw invalid(`Unknown type "${typeName}".`);

    let total = 0;
    for (const collected of collectFields(doc, typeName, selections, vars).values()) {
      const { node } = collected;
      if (node.name === '__typename') {
        total += 1;
        continue;
      }
      if (node.name.startsWith('__')) {
        throw invalid('Introspection is not supported by this endpoint.');
      }
      const def = objectDef.fields[node.name];
      if (!def) throw invalid(`Cannot query field "${node.name}" on type "${typeName}".`);

      const args = resolveArgs(typeName, node.name, def, node, vars);
      const isLeaf = SCALARS.has(def.type.name);
      if (isLeaf && collected.selections.length > 0) {
        throw invalid(`Field "${typeName}.${node.name}" is a scalar and cannot have a selection.`);
      }
      if (!isLeaf && collected.selections.length === 0) {
        throw invalid(`Field "${typeName}.${node.name}" must have a selection of subfields.`);
      }

      const ownLimit = typeof args['limit'] === 'number' ? Math.min(args['limit'], MAX_QUERY_LIMIT) : DEFAULT_QUERY_LIMIT;
      const childPageSize = def.paged ? ownLimit : pageSize;
      const children = isLeaf ? 0 : walk(def.type.name, collected.selections, depth + 1, childPageSize);

      let multiplier = 1;
      if (def.type.list) {
        if (def.size === 'limit') multiplier = ownLimit;
        else if (def.size === 'parent') multiplier = pageSize;
        else multiplier = def.size ?? DEFAULT_QUERY_LIMIT;
      }
      total += 1 + multiplier * children;

      if (total > limits.maxComplexity) {
        throw new GraphQLRequestError(
          'QUERY_TOO_COMPLEX',
          `Query complexity exceeds the maximum of ${limits.maxComplexity}. ` +
            'Request fewer fields, or lower the "limit" of nested lists.',
        );
      }
    }
    return total;
  };

  return walk('Query', operation.selections, 1, DEFAULT_QUERY_LIMIT);
}

// ── Execution ────────────────────────────────────────────────────────────────

class FieldError extends Error {
  constructor(message: string, readonly path: (string | number)[]) {
    super(message);
  }
}

interface ExecState {
  doc: DocumentNode;
  vars: Variables;
  ctx: ResolverContext;
  errors: ResponseError[];
}

async function executeSelection(
  state: ExecState,
  typeName: string,
  selections: SelectionNode[],
  source: unknown,
  path: (string | number)[],
): Promise<Record<string, unknown>> {
  const objectDef = schema[typeName] as ObjectDef;
  const fields = collectFields(state.doc, typeName, selections, state.vars);
  const result: Record<string, unknown> = {};
  // Selected fields are independent, so resolve them concurrently. Insertion
  // order of `result` still follows the document because keys are assigned in
  // the loop below, not in completion order.
  const entries = [...fields.values()];
  const settled = await Promise.all(
    entries.map(async (collected) => {
      const { node, responseKey } = collected;
      const fieldPath = [...path, responseKey];
      if (node.name === '__typename') return { responseKey, value: typeName };
      const def = objectDef.fields[node.name] as FieldDef;
      try {
        const args = resolveArgs(typeName, node.name, def, node, state.vars);
        const raw = def.resolve
          ? await def.resolve(source, args, state.ctx)
          : (source as Record<string, unknown>)[node.name];
        const value = await completeValue(state, def.type, raw, collected.selections, fieldPath);
        return { responseKey, value };
      } catch (error) {
        // A null in a non-null position poisons the parent (GraphQL's rule);
        // a nullable field just becomes null with an entry in `errors`.
        if (def.type.nonNull) throw error;
        state.errors.push(toResponseError(error, fieldPath));
        return { responseKey, value: null };
      }
    }),
  );
  for (const { responseKey, value } of settled) result[responseKey] = value;
  return result;
}

async function completeValue(
  state: ExecState,
  type: TypeRef,
  value: unknown,
  selections: SelectionNode[],
  path: (string | number)[],
): Promise<unknown> {
  if (value === null || value === undefined) {
    if (type.nonNull) throw new FieldError(`Cannot return null for non-nullable field "${path.join('.')}".`, path);
    return null;
  }
  if (type.list) {
    if (!Array.isArray(value)) throw new FieldError(`Expected a list for "${path.join('.')}".`, path);
    const itemType: TypeRef = { name: type.name, nonNull: type.itemNonNull ?? false };
    return Promise.all(value.map((item, i) => completeValue(state, itemType, item, selections, [...path, i])));
  }
  if (SCALARS.has(type.name)) return value as JsonValue;
  return executeSelection(state, type.name, selections, value, path);
}

function toResponseError(error: unknown, path: (string | number)[]): ResponseError {
  if (error instanceof ApiError) {
    return { message: error.message, path, extensions: { code: 'BAD_USER_INPUT' } };
  }
  if (error instanceof GraphQLRequestError) {
    return { message: error.message, path, extensions: { code: error.code } };
  }
  if (error instanceof FieldError) {
    return { message: error.message, path: error.path, extensions: { code: 'INTERNAL_ERROR' } };
  }
  // Do not leak internals (SQL errors, file paths) to an unauthenticated client.
  return { message: 'Internal error.', path, extensions: { code: 'INTERNAL_ERROR' } };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** What `executeGraphQL` returns: an HTTP status and the response body. */
export interface GraphQLResult {
  status: number;
  body: GraphQLResponse;
}

function coerceVariables(operation: OperationNode, provided: unknown): Variables {
  if (provided !== undefined && provided !== null && (typeof provided !== 'object' || Array.isArray(provided))) {
    throw new GraphQLRequestError('BAD_USER_INPUT', '"variables" must be a JSON object.');
  }
  const given = (provided ?? {}) as Record<string, unknown>;
  const vars: Variables = {};
  for (const def of operation.variables) {
    if (def.name in given) {
      vars[def.name] = given[def.name];
    } else if (def.defaultValue) {
      vars[def.name] = valueOf(def.defaultValue, {});
    }
    if (def.nonNull && (vars[def.name] === undefined || vars[def.name] === null)) {
      throw new GraphQLRequestError('BAD_USER_INPUT', `Variable "$${def.name}" of type "${def.type}" is required.`);
    }
  }
  return vars;
}

export async function executeGraphQL(
  request: GraphQLRequest,
  store: EventStore,
  options: GraphQLOptions = {},
): Promise<GraphQLResult> {
  const limits: Limits = {
    maxDepth: options.maxDepth ?? DEFAULT_GRAPHQL_MAX_DEPTH,
    maxComplexity: options.maxComplexity ?? DEFAULT_GRAPHQL_MAX_COMPLEXITY,
  };
  const maxLength = options.maxQueryLength ?? DEFAULT_GRAPHQL_MAX_QUERY_LENGTH;

  try {
    if (typeof request.query !== 'string' || request.query.trim() === '') {
      throw new GraphQLRequestError('GRAPHQL_PARSE_FAILED', 'A "query" string is required.');
    }
    if (request.query.length > maxLength) {
      throw new GraphQLRequestError('QUERY_TOO_LARGE', `The query is longer than ${maxLength} characters.`);
    }

    const doc = parseDocument(request.query);

    let operation: OperationNode | undefined;
    if (request.operationName) {
      operation = doc.operations.find((op) => op.name === request.operationName);
      if (!operation) throw invalid(`Unknown operation "${request.operationName}".`);
    } else if (doc.operations.length === 1) {
      operation = doc.operations[0];
    } else {
      throw invalid('The document has several operations; pass "operationName".');
    }
    if (!operation) throw invalid('No operation to execute.');
    if (operation.operation !== 'query') {
      throw invalid(`This endpoint is read-only: ${operation.operation}s are not supported.`);
    }

    const vars = coerceVariables(operation, request.variables);
    // Everything that can be rejected is rejected here, before the store is touched.
    analyse(doc, operation, vars, limits);

    let contractMap: Promise<Map<string, ContractSummary>> | undefined;
    const ctx: ResolverContext = {
      store,
      contracts: () => {
        contractMap ??= store
          .listContracts(MAX_QUERY_LIMIT)
          .then((list) => new Map(list.map((c) => [c.contractId, c])));
        return contractMap;
      },
    };

    const state: ExecState = { doc, vars, ctx, errors: [] };
    try {
      const data = await executeSelection(state, 'Query', operation.selections, {}, []);
      return {
        status: 200,
        body: { data, ...(state.errors.length > 0 ? { errors: state.errors } : {}) },
      };
    } catch (error) {
      return {
        status: 200,
        body: { data: null, errors: [...state.errors, toResponseError(error, [])] },
      };
    }
  } catch (error) {
    if (error instanceof GraphQLRequestError) {
      return {
        status: 400,
        body: { errors: [{ message: error.message, extensions: { code: error.code } }] },
      };
    }
    throw error;
  }
}
