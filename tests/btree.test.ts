import { describe, expect, it } from "vitest";
import { BPlusTree } from "../src/index.js";

const numeric = (a: number, b: number) => a - b;

/** Small deterministic PRNG so failures are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("BPlusTree", () => {
  it("stores and retrieves values", () => {
    const tree = new BPlusTree<number, string>(numeric, 4);
    for (const k of [5, 1, 9, 3, 7]) tree.set(k, `v${k}`);
    expect(tree.get(3)).toBe("v3");
    expect(tree.get(4)).toBeUndefined();
    expect(tree.has(9)).toBe(true);
    expect(tree.size).toBe(5);
    expect([...tree.keys()]).toEqual([1, 3, 5, 7, 9]);
  });

  it("replaces existing keys without growing", () => {
    const tree = new BPlusTree<number, string>(numeric);
    expect(tree.set(1, "a")).toBe(true);
    expect(tree.set(1, "b")).toBe(false);
    expect(tree.size).toBe(1);
    expect(tree.get(1)).toBe("b");
  });

  it("grows in height as it splits", () => {
    const tree = new BPlusTree<number, number>(numeric, 4);
    for (let i = 0; i < 1000; i++) tree.set(i, i);
    expect(tree.height).toBeGreaterThan(3);
    tree.checkInvariants();
  });

  it("iterates in both directions", () => {
    const tree = new BPlusTree<number, number>(numeric, 4);
    for (let i = 0; i < 50; i++) tree.set(i * 2, i);
    expect([...tree.entries()].map((e) => e.key)).toEqual(Array.from({ length: 50 }, (_, i) => i * 2));
    expect([...tree.entriesReversed()].map((e) => e.key)).toEqual(Array.from({ length: 50 }, (_, i) => 98 - i * 2));
  });

  it("seeks to the first key satisfying a predicate", () => {
    const tree = new BPlusTree<number, number>(numeric, 4);
    for (let i = 0; i < 100; i++) tree.set(i * 3, i);
    const fromKey = (k: number) => [...tree.seek((x) => x >= k)].map((e) => e.key);
    expect(fromKey(50).slice(0, 3)).toEqual([51, 54, 57]);
    expect(fromKey(0)[0]).toBe(0);
    expect(fromKey(1000)).toEqual([]);
  });

  it("seeks backwards to the last key not past the end", () => {
    const tree = new BPlusTree<number, number>(numeric, 4);
    for (let i = 0; i < 100; i++) tree.set(i * 3, i);
    const upTo = (k: number) => [...tree.seekReversed((x) => x > k)].map((e) => e.key);
    expect(upTo(50).slice(0, 3)).toEqual([48, 45, 42]);
    expect(upTo(-1)).toEqual([]);
    expect(upTo(10_000)[0]).toBe(297);
  });

  it("deletes keys, rebalancing as needed", () => {
    const tree = new BPlusTree<number, number>(numeric, 4);
    for (let i = 0; i < 200; i++) tree.set(i, i);
    for (let i = 0; i < 200; i += 2) expect(tree.delete(i)).toBe(true);
    expect(tree.delete(0)).toBe(false);
    tree.checkInvariants();
    expect([...tree.keys()]).toEqual(Array.from({ length: 100 }, (_, i) => i * 2 + 1));
    for (let i = 1; i < 200; i += 2) tree.delete(i);
    expect(tree.size).toBe(0);
    expect(tree.height).toBe(1);
    tree.checkInvariants();
  });

  it("supports composite keys", () => {
    const cmp = (a: [string, number], b: [string, number]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
    const tree = new BPlusTree<[string, number], null>(cmp, 4);
    for (const name of ["b", "a", "c"]) for (let i = 3; i > 0; i--) tree.set([name, i], null);
    expect([...tree.keys()].map((k) => k.join(""))).toEqual(["a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3"]);
  });

  for (const order of [4, 5, 8, 64]) {
    it(`matches a reference map under random operations (order ${order})`, () => {
      const random = rng(order * 7919);
      const tree = new BPlusTree<number, number>(numeric, order);
      const reference = new Map<number, number>();
      for (let step = 0; step < 5000; step++) {
        const key = Math.floor(random() * 500);
        if (random() < 0.6) {
          tree.set(key, step);
          reference.set(key, step);
        } else {
          expect(tree.delete(key)).toBe(reference.delete(key));
        }
        if (step % 500 === 0) tree.checkInvariants();
      }
      tree.checkInvariants();
      const expected = [...reference.entries()].sort((a, b) => a[0] - b[0]);
      expect([...tree.entries()].map((e) => [e.key, e.value])).toEqual(expected);
      expect(tree.size).toBe(reference.size);

      // Random range scans in both directions.
      const keys = expected.map((e) => e[0]);
      for (let i = 0; i < 50; i++) {
        const lo = Math.floor(random() * 520) - 10;
        expect([...tree.seek((k) => k >= lo)].map((e) => e.key)).toEqual(keys.filter((k) => k >= lo));
        expect([...tree.seekReversed((k) => k > lo)].map((e) => e.key)).toEqual(keys.filter((k) => k <= lo).reverse());
      }
    });
  }
});
