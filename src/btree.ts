/**
 * An in-memory B+ tree. Keys live in the leaves, which are doubly linked so
 * ordered scans in either direction are cheap. Internal nodes only hold
 * separator keys: every key in `children[i]` is `< keys[i]` and every key in
 * `children[i + 1]` is `>= keys[i]`.
 */

export type Comparator<K> = (a: K, b: K) => number;

interface LeafNode<K, V> {
  leaf: true;
  keys: K[];
  values: V[];
  next: LeafNode<K, V> | null;
  prev: LeafNode<K, V> | null;
}

interface InternalNode<K, V> {
  leaf: false;
  keys: K[];
  children: Node<K, V>[];
}

type Node<K, V> = LeafNode<K, V> | InternalNode<K, V>;

export interface Entry<K, V> {
  key: K;
  value: V;
}

/** Binary search for the first element satisfying a monotone predicate. */
function firstTrue<K>(keys: K[], pred: (key: K) => boolean): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(keys[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function newLeaf<K, V>(): LeafNode<K, V> {
  return { leaf: true, keys: [], values: [], next: null, prev: null };
}

export class BPlusTree<K, V> {
  private root: Node<K, V> = newLeaf();
  private count = 0;
  private readonly maxKeys: number;
  private readonly minKeys: number;

  constructor(
    private readonly compare: Comparator<K>,
    order = 64,
  ) {
    if (order < 4) throw new Error("B+ tree order must be at least 4");
    this.maxKeys = order - 1;
    this.minKeys = Math.floor(this.maxKeys / 2);
  }

  get size(): number {
    return this.count;
  }

  /** Height of the tree (1 for a single leaf). Mostly useful for tests. */
  get height(): number {
    let h = 1;
    let node = this.root;
    while (!node.leaf) {
      node = node.children[0]!;
      h++;
    }
    return h;
  }

  clear(): void {
    this.root = newLeaf();
    this.count = 0;
  }

  /** Index of the first key in `keys` that is `>= key` (or `> key` when `strict`). */
  private lowerBound(keys: K[], key: K, strict = false): number {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const c = this.compare(keys[mid]!, key);
      if (c < 0 || (strict && c === 0)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private findLeaf(key: K): LeafNode<K, V> {
    let node = this.root;
    while (!node.leaf) node = node.children[this.lowerBound(node.keys, key, true)]!;
    return node;
  }

  get(key: K): V | undefined {
    const leaf = this.findLeaf(key);
    const i = this.lowerBound(leaf.keys, key);
    if (i < leaf.keys.length && this.compare(leaf.keys[i]!, key) === 0) return leaf.values[i];
    return undefined;
  }

  has(key: K): boolean {
    const leaf = this.findLeaf(key);
    const i = this.lowerBound(leaf.keys, key);
    return i < leaf.keys.length && this.compare(leaf.keys[i]!, key) === 0;
  }

  /** Inserts or replaces the value stored under `key`. Returns true if the key was new. */
  set(key: K, value: V): boolean {
    const result = this.insertInto(this.root, key, value);
    if (result.split) {
      this.root = { leaf: false, keys: [result.split.separator], children: [this.root, result.split.right] };
    }
    if (result.added) this.count++;
    return result.added;
  }

  private insertInto(
    node: Node<K, V>,
    key: K,
    value: V,
  ): { added: boolean; split?: { separator: K; right: Node<K, V> } } {
    if (node.leaf) {
      const i = this.lowerBound(node.keys, key);
      if (i < node.keys.length && this.compare(node.keys[i]!, key) === 0) {
        node.values[i] = value;
        return { added: false };
      }
      node.keys.splice(i, 0, key);
      node.values.splice(i, 0, value);
      if (node.keys.length <= this.maxKeys) return { added: true };

      const mid = node.keys.length >>> 1;
      const right: LeafNode<K, V> = {
        leaf: true,
        keys: node.keys.splice(mid),
        values: node.values.splice(mid),
        next: node.next,
        prev: node,
      };
      if (node.next) node.next.prev = right;
      node.next = right;
      return { added: true, split: { separator: right.keys[0]!, right } };
    }

    const ci = this.lowerBound(node.keys, key, true);
    const result = this.insertInto(node.children[ci]!, key, value);
    if (!result.split) return result;

    node.keys.splice(ci, 0, result.split.separator);
    node.children.splice(ci + 1, 0, result.split.right);
    if (node.keys.length <= this.maxKeys) return { added: result.added };

    const mid = node.keys.length >>> 1;
    const separator = node.keys[mid]!;
    const right: InternalNode<K, V> = {
      leaf: false,
      keys: node.keys.splice(mid + 1),
      children: node.children.splice(mid + 1),
    };
    node.keys.length = mid;
    return { added: result.added, split: { separator, right } };
  }

  /** Removes `key`. Returns true if it was present. */
  delete(key: K): boolean {
    const removed = this.deleteFrom(this.root, key);
    if (!this.root.leaf && this.root.keys.length === 0) this.root = this.root.children[0]!;
    if (removed) this.count--;
    return removed;
  }

  private deleteFrom(node: Node<K, V>, key: K): boolean {
    if (node.leaf) {
      const i = this.lowerBound(node.keys, key);
      if (i >= node.keys.length || this.compare(node.keys[i]!, key) !== 0) return false;
      node.keys.splice(i, 1);
      node.values.splice(i, 1);
      return true;
    }
    const ci = this.lowerBound(node.keys, key, true);
    const child = node.children[ci]!;
    const removed = this.deleteFrom(child, key);
    if (removed && child.keys.length < this.minKeys) this.rebalance(node, ci);
    return removed;
  }

  /** Fixes an underflowing `parent.children[ci]` by borrowing from or merging with a sibling. */
  private rebalance(parent: InternalNode<K, V>, ci: number): void {
    const child = parent.children[ci]!;
    const left = ci > 0 ? parent.children[ci - 1]! : undefined;
    const right = ci < parent.children.length - 1 ? parent.children[ci + 1]! : undefined;

    if (child.leaf) {
      const l = left as LeafNode<K, V> | undefined;
      const r = right as LeafNode<K, V> | undefined;
      if (l && l.keys.length > this.minKeys) {
        child.keys.unshift(l.keys.pop()!);
        child.values.unshift(l.values.pop()!);
        parent.keys[ci - 1] = child.keys[0]!;
        return;
      }
      if (r && r.keys.length > this.minKeys) {
        child.keys.push(r.keys.shift()!);
        child.values.push(r.values.shift()!);
        parent.keys[ci] = r.keys[0]!;
        return;
      }
      if (l) this.mergeLeaves(parent, ci - 1);
      else if (r) this.mergeLeaves(parent, ci);
      return;
    }

    const l = left as InternalNode<K, V> | undefined;
    const r = right as InternalNode<K, V> | undefined;
    if (l && l.keys.length > this.minKeys) {
      child.keys.unshift(parent.keys[ci - 1]!);
      child.children.unshift(l.children.pop()!);
      parent.keys[ci - 1] = l.keys.pop()!;
      return;
    }
    if (r && r.keys.length > this.minKeys) {
      child.keys.push(parent.keys[ci]!);
      child.children.push(r.children.shift()!);
      parent.keys[ci] = r.keys.shift()!;
      return;
    }
    if (l) this.mergeInternal(parent, ci - 1);
    else if (r) this.mergeInternal(parent, ci);
  }

  /** Merges `parent.children[i + 1]` (a leaf) into `parent.children[i]`. */
  private mergeLeaves(parent: InternalNode<K, V>, i: number): void {
    const a = parent.children[i] as LeafNode<K, V>;
    const b = parent.children[i + 1] as LeafNode<K, V>;
    a.keys.push(...b.keys);
    a.values.push(...b.values);
    a.next = b.next;
    if (b.next) b.next.prev = a;
    parent.keys.splice(i, 1);
    parent.children.splice(i + 1, 1);
  }

  private mergeInternal(parent: InternalNode<K, V>, i: number): void {
    const a = parent.children[i] as InternalNode<K, V>;
    const b = parent.children[i + 1] as InternalNode<K, V>;
    a.keys.push(parent.keys[i]!, ...b.keys);
    a.children.push(...b.children);
    parent.keys.splice(i, 1);
    parent.children.splice(i + 1, 1);
  }

  private firstLeaf(): LeafNode<K, V> {
    let node = this.root;
    while (!node.leaf) node = node.children[0]!;
    return node;
  }

  private lastLeaf(): LeafNode<K, V> {
    let node = this.root;
    while (!node.leaf) node = node.children[node.children.length - 1]!;
    return node;
  }

  /** All entries in ascending key order. */
  *entries(): Generator<Entry<K, V>> {
    for (let leaf: LeafNode<K, V> | null = this.firstLeaf(); leaf; leaf = leaf.next) {
      for (let i = 0; i < leaf.keys.length; i++) yield { key: leaf.keys[i]!, value: leaf.values[i]! };
    }
  }

  /** All entries in descending key order. */
  *entriesReversed(): Generator<Entry<K, V>> {
    for (let leaf: LeafNode<K, V> | null = this.lastLeaf(); leaf; leaf = leaf.prev) {
      for (let i = leaf.keys.length - 1; i >= 0; i--) yield { key: leaf.keys[i]!, value: leaf.values[i]! };
    }
  }

  /**
   * The values of each leaf in ascending key order, one array per leaf. Much
   * cheaper than {@link entries} for full scans. The arrays must not be modified.
   */
  *valueChunks(): Generator<readonly V[]> {
    for (let leaf: LeafNode<K, V> | null = this.firstLeaf(); leaf; leaf = leaf.next) {
      if (leaf.values.length) yield leaf.values;
    }
  }

  *keys(): Generator<K> {
    for (const e of this.entries()) yield e.key;
  }

  *values(): Generator<V> {
    for (const e of this.entries()) yield e.value;
  }

  /**
   * Ascending scan starting at the first key for which `atOrAfterStart(key)` is
   * true. The predicate must be monotone over the key order (false…false,
   * true…true). Iteration continues until the caller stops consuming.
   */
  *seek(atOrAfterStart: (key: K) => boolean): Generator<Entry<K, V>> {
    let node = this.root;
    while (!node.leaf) {
      node = node.children[firstTrue(node.keys, atOrAfterStart)]!;
    }
    let leaf: LeafNode<K, V> | null = node;
    let i = firstTrue(leaf.keys, atOrAfterStart);
    for (; leaf; leaf = leaf.next, i = 0) {
      for (; i < leaf.keys.length; i++) yield { key: leaf.keys[i]!, value: leaf.values[i]! };
    }
  }

  /**
   * Descending scan starting at the last key for which `afterEnd(key)` is
   * false. `afterEnd` must be monotone over the key order.
   */
  *seekReversed(afterEnd: (key: K) => boolean): Generator<Entry<K, V>> {
    let node = this.root;
    while (!node.leaf) {
      node = node.children[firstTrue(node.keys, afterEnd)]!;
    }
    let leaf: LeafNode<K, V> | null = node;
    let i = firstTrue(leaf.keys, afterEnd) - 1;
    // The last matching key may live in the previous leaf.
    if (i < 0) {
      leaf = leaf.prev;
      i = leaf ? leaf.keys.length - 1 : -1;
    }
    for (; leaf; leaf = leaf.prev, i = leaf ? leaf.keys.length - 1 : -1) {
      for (; i >= 0; i--) yield { key: leaf.keys[i]!, value: leaf.values[i]! };
    }
  }

  /** Verifies structural invariants; throws on corruption. Intended for tests. */
  checkInvariants(): void {
    let leafDepth = -1;
    let seen = 0;
    const visit = (node: Node<K, V>, depth: number, lo: K | undefined, hi: K | undefined, isRoot: boolean): void => {
      if (!isRoot && node.keys.length < this.minKeys) throw new Error("Underfull node");
      if (node.keys.length > this.maxKeys) throw new Error("Overfull node");
      for (let i = 1; i < node.keys.length; i++) {
        if (this.compare(node.keys[i - 1]!, node.keys[i]!) >= 0) throw new Error("Keys out of order");
      }
      for (const k of node.keys) {
        if (lo !== undefined && this.compare(k, lo) < 0) throw new Error("Key below lower bound");
        if (hi !== undefined && this.compare(k, hi) >= 0) throw new Error("Key above upper bound");
      }
      if (node.leaf) {
        if (leafDepth === -1) leafDepth = depth;
        else if (leafDepth !== depth) throw new Error("Leaves at different depths");
        if (node.values.length !== node.keys.length) throw new Error("Key/value length mismatch");
        seen += node.keys.length;
        return;
      }
      if (node.children.length !== node.keys.length + 1) throw new Error("Child count mismatch");
      node.children.forEach((child, i) => {
        visit(child, depth + 1, i === 0 ? lo : node.keys[i - 1], i === node.keys.length ? hi : node.keys[i], false);
      });
    };
    visit(this.root, 0, undefined, undefined, true);
    if (seen !== this.count) throw new Error(`Size mismatch: counted ${seen}, recorded ${this.count}`);

    let prev: LeafNode<K, V> | null = null;
    let linked = 0;
    for (let leaf: LeafNode<K, V> | null = this.firstLeaf(); leaf; leaf = leaf.next) {
      if (leaf.prev !== prev) throw new Error("Broken prev link");
      linked += leaf.keys.length;
      prev = leaf;
    }
    if (linked !== this.count) throw new Error("Leaf chain does not cover all keys");
  }
}
