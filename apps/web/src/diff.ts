import type { DecodedValue, LensEvent, TypedEvent } from './types.js';

/**
 * Structural diff between two decoded payloads.
 *
 * Maps diff by key (a key present on one side only is added/removed, not a
 * wholesale change) and vecs diff by index, which is what makes a transfer
 * whose `amount` moved from "100" to "110" readable as one changed field
 * rather than two opaque JSON blobs.
 */

export type DiffStatus = 'same' | 'changed' | 'added' | 'removed';

export interface DiffNode {
  /** Path into the payload: `value.amount`, `topic[1]`, `field.to`. */
  path: string;
  status: DiffStatus;
  /** Leaf payload. `undefined` on the side that has no value (added/removed). */
  left?: unknown;
  right?: unknown;
  /** Structured children for maps and vecs; absent on leaves. */
  children?: DiffNode[];
}

/** Everything two events can be compared on, computed once. */
export interface EventDiff {
  topics: DiffNode[];
  value: DiffNode;
  /** Spec-decoded field diffs, or null when either event has no spec match. */
  typedFields: DiffNode[] | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => deepEqual(item, right[i]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    return (
      leftKeys.length === Object.keys(right).length &&
      leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

/** Recursively diff two decoded values under `path`. */
export function diffValues(left: unknown, right: unknown, path: string): DiffNode {
  if (deepEqual(left, right)) return { path, status: 'same', left, right };

  if (Array.isArray(left) && Array.isArray(right)) {
    const children: DiffNode[] = [];
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const childPath = `${path}[${i}]`;
      if (i >= right.length) children.push({ path: childPath, status: 'removed', left: left[i] });
      else if (i >= left.length) children.push({ path: childPath, status: 'added', right: right[i] });
      else children.push(diffValues(left[i], right[i], childPath));
    }
    return { path, status: 'changed', children };
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const children: DiffNode[] = [];
    const keys = [...Object.keys(left), ...Object.keys(right).filter((key) => !(key in left))];
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (!(key in right)) children.push({ path: childPath, status: 'removed', left: left[key] });
      else if (!(key in left)) children.push({ path: childPath, status: 'added', right: right[key] });
      else children.push(diffValues(left[key], right[key], childPath));
    }
    return { path, status: 'changed', children };
  }

  return { path, status: 'changed', left, right };
}

/** Diff two topic lists positionally: `topic[0]` against `topic[0]`, and so on. */
export function diffTopics(left: DecodedValue[], right: DecodedValue[]): DiffNode[] {
  const nodes: DiffNode[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const path = `topic[${i}]`;
    const l = left[i];
    const r = right[i];
    if (l === undefined) {
      nodes.push({ path, status: 'added', right: r });
    } else if (r === undefined) {
      nodes.push({ path, status: 'removed', left: l });
    } else if (l.type !== r.type) {
      // Same slot, different ScVal arm: the whole topic changed shape.
      nodes.push({ path, status: 'changed', left: l, right: r });
    } else {
      nodes.push(diffValues(l.value, r.value, path));
    }
  }
  return nodes;
}

/** Diff spec-decoded fields by name, or null when either event has no spec match. */
export function diffTypedFields(left: TypedEvent, right: TypedEvent): DiffNode[] {
  const nodes: DiffNode[] = [];
  if (left.name !== right.name) {
    nodes.push({ path: 'event', status: 'changed', left: left.name, right: right.name });
  }
  const rightFields = new Map(right.fields.map((f) => [f.name, f]));
  const seen = new Set<string>();
  for (const field of left.fields) {
    seen.add(field.name);
    const other = rightFields.get(field.name);
    const path = `field.${field.name}`;
    if (other === undefined) {
      nodes.push({ path, status: 'removed', left: field.value });
    } else if (other.type !== field.type) {
      nodes.push({ path, status: 'changed', left: field.value, right: other.value });
    } else {
      nodes.push(diffValues(field.value, other.value, path));
    }
  }
  for (const field of right.fields) {
    if (!seen.has(field.name)) nodes.push({ path: `field.${field.name}`, status: 'added', right: field.value });
  }
  return nodes;
}

/** Compute every part of the comparison between two events. */
export function diffEvents(left: LensEvent, right: LensEvent): EventDiff {
  return {
    topics: diffTopics(left.topics, right.topics),
    value: diffValues(left.value.value, right.value.value, 'value'),
    typedFields:
      left.typed && right.typed ? diffTypedFields(left.typed, right.typed) : null,
  };
}
