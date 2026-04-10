import { describe, it, expect, beforeEach } from "bun:test";
import { createClient } from "@libsql/client";
import {
	newClient,
	InvalidKeyError,
	InvalidNamespaceError,
	KeyNotFoundError,
	DuplicateKeyError,
} from "../index";

function makeDb() {
	return createClient({ url: "file::memory:" });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("key validation", () => {
	it("rejects empty key", async () => {
		const ns = newClient(makeDb()).namespace("test");
		expect(ns.put([], { x: 1 })).rejects.toBeInstanceOf(InvalidKeyError);
	});

	it("rejects segment starting with a number", async () => {
		const ns = newClient(makeDb()).namespace("test");
		expect(ns.put(["1bad"], { x: 1 })).rejects.toBeInstanceOf(InvalidKeyError);
	});

	it("rejects segment with special chars", async () => {
		const ns = newClient(makeDb()).namespace("test");
		expect(ns.put(["bad-key"], { x: 1 })).rejects.toBeInstanceOf(InvalidKeyError);
	});

	it("accepts valid multi-segment key", async () => {
		const ns = newClient(makeDb()).namespace("test");
		await expect(ns.put(["users", "alice"], { name: "Alice" })).resolves.toBeUndefined();
	});

	it("rejects too many segments", async () => {
		const ns = newClient(makeDb()).namespace("test");
		const key = Array.from({ length: 17 }, (_, i) => `seg${i}`);
		expect(ns.put(key, {})).rejects.toBeInstanceOf(InvalidKeyError);
	});
});

describe("namespace validation", () => {
	it("rejects namespace starting with a number", () => {
		expect(() => newClient(makeDb()).namespace("1bad")).toThrow(InvalidNamespaceError);
	});

	it("rejects namespace with hyphens", () => {
		expect(() => newClient(makeDb()).namespace("bad-ns")).toThrow(InvalidNamespaceError);
	});
});

// ---------------------------------------------------------------------------
// Auto-init (no pre-created tables)
// ---------------------------------------------------------------------------

describe("table auto-init", () => {
	it("creates the table on first put without manual DDL", async () => {
		const ns = newClient(makeDb()).namespace("fresh");
		await ns.put(["a"], { v: 1 });
		const row = await ns.get(["a"]);
		expect(row?.value).toEqual({ v: 1 });
	});

	it("parallel puts on a fresh namespace do not race", async () => {
		const db = makeDb();
		const ns = newClient(db).namespace("race");
		await Promise.all([ns.put(["a"], { v: 1 }), ns.put(["b"], { v: 2 }), ns.put(["c"], { v: 3 })]);
		expect(await ns.exists(["a"])).toBe(true);
		expect(await ns.exists(["b"])).toBe(true);
		expect(await ns.exists(["c"])).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// put / get / update / delete
// ---------------------------------------------------------------------------

describe("put", () => {
	it("stores and retrieves a value", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["hello"], { msg: "world" });
		const row = await ns.get(["hello"]);
		expect(row?.value).toEqual({ msg: "world" });
	});

	it("throws DuplicateKeyError on duplicate key", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["dup"], { a: 1 });
		expect(ns.put(["dup"], { a: 2 })).rejects.toBeInstanceOf(DuplicateKeyError);
	});

	it("round-trips complex JSON", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		const value = { arr: [1, 2, 3], nested: { x: true, y: null } };
		await ns.put(["complex"], value);
		const row = await ns.get(["complex"]);
		expect(row?.value).toEqual(value);
	});

	it("returns timestamps as Date objects", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		const before = Date.now();
		await ns.put(["ts"], { v: 1 });
		const row = await ns.get(["ts"]);
		expect(row?.created_at).toBeInstanceOf(Date);
		expect(row?.updated_at).toBeInstanceOf(Date);
		expect(row!.created_at.getTime()).toBeGreaterThanOrEqual(before);
	});

	it("accepts custom created_at and updated_at", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		const created = new Date("2020-01-01T00:00:00Z");
		const updated = new Date("2021-06-15T12:00:00Z");
		await ns.put(["ts"], { v: 1 }, { created_at: created, updated_at: updated });
		const row = await ns.get(["ts"]);
		expect(row!.created_at.getTime()).toBe(created.getTime());
		expect(row!.updated_at.getTime()).toBe(updated.getTime());
	});
});

describe("get", () => {
	it("returns null for missing key", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		expect(await ns.get(["missing"])).toBeNull();
	});
});

describe("update", () => {
	it("replaces the value", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["k"], { a: 1 });
		await ns.update(["k"], { a: 2 });
		expect((await ns.get(["k"]))?.value).toEqual({ a: 2 });
	});

	it("throws KeyNotFoundError for missing key", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		expect(ns.update(["nope"], { a: 1 })).rejects.toBeInstanceOf(KeyNotFoundError);
	});
});

describe("delete", () => {
	it("removes the entry", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["k"], { a: 1 });
		await ns.delete(["k"]);
		expect(await ns.get(["k"])).toBeNull();
	});

	it("is silent for non-existent key", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await expect(ns.delete(["ghost"])).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// set (upsert) and exists
// ---------------------------------------------------------------------------

describe("set", () => {
	it("inserts when key does not exist", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.set(["new"], { v: 1 });
		expect((await ns.get(["new"]))?.value).toEqual({ v: 1 });
	});

	it("replaces when key exists", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["k"], { v: 1 });
		await ns.set(["k"], { v: 99 });
		expect((await ns.get(["k"]))?.value).toEqual({ v: 99 });
	});

	it("preserves created_at on update", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["k"], { v: 1 });
		const original = (await ns.get(["k"]))!.created_at;
		await new Promise((r) => setTimeout(r, 5));
		await ns.set(["k"], { v: 2 });
		const after = (await ns.get(["k"]))!.created_at;
		expect(after.getTime()).toBe(original.getTime());
	});
});

describe("exists", () => {
	it("returns true for existing key", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["k"], { v: 1 });
		expect(await ns.exists(["k"])).toBe(true);
	});

	it("returns false for missing key", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		expect(await ns.exists(["nope"])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// patch
// ---------------------------------------------------------------------------

describe("patch", () => {
	it("merges partial value into existing entry", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["k"], { a: 1, b: 2 });
		await ns.patch(["k"], { b: 99, c: 3 });
		expect((await ns.get(["k"]))?.value).toEqual({ a: 1, b: 99, c: 3 });
	});

	it("throws KeyNotFoundError for missing key", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		expect(ns.patch(["nope"], { a: 1 })).rejects.toBeInstanceOf(KeyNotFoundError);
	});
});

// ---------------------------------------------------------------------------
// list — cursor pagination
// ---------------------------------------------------------------------------

describe("list", () => {
	async function seedNs() {
		const ns = newClient(makeDb()).namespace("kv");
		for (let i = 1; i <= 5; i++) {
			await ns.put([`item${i}`], { i });
		}
		return ns;
	}

	it("returns all rows within limit", async () => {
		const ns = await seedNs();
		const result = await ns.list({ limit: 10 });
		expect(result.rows).toHaveLength(5);
		expect(result.cursor).toBeNull();
	});

	it("paginates with cursor", async () => {
		const ns = await seedNs();
		const page1 = await ns.list({ limit: 2 });
		expect(page1.rows).toHaveLength(2);
		expect(page1.cursor).not.toBeNull();

		const page2 = await ns.list({ limit: 2, cursor: page1.cursor! });
		expect(page2.rows).toHaveLength(2);

		const page3 = await ns.list({ limit: 2, cursor: page2.cursor! });
		expect(page3.rows).toHaveLength(1);
		expect(page3.cursor).toBeNull();
	});

	it("cursor pagination covers all items without overlap", async () => {
		const ns = await seedNs();
		const allKeys: string[] = [];
		let cursor: string | null = null;
		do {
			const result = await ns.list({ limit: 2, cursor: cursor ?? undefined });
			allKeys.push(...result.rows.map((r) => r.key));
			cursor = result.cursor;
		} while (cursor);
		expect(allKeys).toHaveLength(5);
		expect(new Set(allKeys).size).toBe(5);
	});

	it("returns rows in descending order", async () => {
		const ns = await seedNs();
		const result = await ns.list({ limit: 5, order: "desc" });
		const keys = result.rows.map((r) => r.key);
		expect(keys).toEqual([...keys].sort().reverse());
	});

	it("includes metadata when includeMeta is true", async () => {
		const ns = await seedNs();
		const result = await ns.list({ limit: 5, includeMeta: true });
		for (const row of result.rows) {
			expect(row.created_at).toBeInstanceOf(Date);
			expect(row.updated_at).toBeInstanceOf(Date);
		}
	});

	it("filters by prefix", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["users", "alice"], { role: "admin" });
		await ns.put(["users", "bob"], { role: "user" });
		await ns.put(["posts", "one"], { title: "Hello" });

		const result = await ns.list({ limit: 10, prefix: ["users"] });
		expect(result.rows.every((r) => r.key.startsWith("users"))).toBe(true);
		expect(result.rows).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// putMany / deleteMany
// ---------------------------------------------------------------------------

describe("putMany", () => {
	it("inserts all entries atomically", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.putMany([
			{ key: ["a"], value: { v: 1 } },
			{ key: ["b"], value: { v: 2 } },
			{ key: ["c"], value: { v: 3 } },
		]);
		expect(await ns.exists(["a"])).toBe(true);
		expect(await ns.exists(["b"])).toBe(true);
		expect(await ns.exists(["c"])).toBe(true);
	});
});

describe("deleteMany", () => {
	it("removes all specified keys", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.putMany([
			{ key: ["a"], value: { v: 1 } },
			{ key: ["b"], value: { v: 2 } },
		]);
		await ns.deleteMany([["a"], ["b"]]);
		expect(await ns.exists(["a"])).toBe(false);
		expect(await ns.exists(["b"])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// transaction
// ---------------------------------------------------------------------------

describe("transaction", () => {
	it("applies all ops atomically", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.transaction(async (tx) => {
			tx.put(["x"], { v: 1 });
			tx.put(["y"], { v: 2 });
		});
		expect((await ns.get(["x"]))?.value).toEqual({ v: 1 });
		expect((await ns.get(["y"]))?.value).toEqual({ v: 2 });
	});

	it("transaction delete removes entry", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		await ns.put(["del"], { v: 1 });
		await ns.transaction(async (tx) => {
			tx.delete(["del"]);
		});
		expect(await ns.exists(["del"])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Namespace policy
// ---------------------------------------------------------------------------

describe("namespace policy", () => {
	it("blocks namespace not in allowlist", () => {
		const client = newClient(makeDb(), {
			namespacePolicy: { allowlist: ["allowed"] },
		});
		expect(() => client.namespace("blocked")).toThrow(InvalidNamespaceError);
	});

	it("allows namespace in allowlist", () => {
		const client = newClient(makeDb(), {
			namespacePolicy: { allowlist: ["allowed"] },
		});
		expect(() => client.namespace("allowed")).not.toThrow();
	});

	it("enforces maxNamespaces limit", () => {
		const client = newClient(makeDb(), {
			namespacePolicy: { maxNamespaces: 1 },
		});
		client.namespace("first");
		expect(() => client.namespace("second")).toThrow(RangeError);
	});
});

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

describe("size limits", () => {
	it("rejects oversized serialized value", async () => {
		const ns = newClient(makeDb()).namespace("kv");
		const big = { data: "x".repeat(2_000_000) };
		expect(ns.put(["big"], big)).rejects.toThrow(RangeError);
	});
});
