import type { Client } from "@libsql/client";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class InvalidKeyError extends Error {
	constructor(segment: string) {
		super(
			`InvalidKey: A valid key segment must start with a letter and can only contain letters, numbers, and underscores: ${segment}`,
		);
		this.name = "InvalidKeyError";
	}
}

export class InvalidNamespaceError extends Error {
	constructor(name: string) {
		super(
			`InvalidNamespace: A valid namespace must start with a letter and can only contain letters, numbers, and underscores: ${name}`,
		);
		this.name = "InvalidNamespaceError";
	}
}

export class KeyNotFoundError extends Error {
	constructor(key: string) {
		super(`KeyNotFound: No entry exists for key: ${key}`);
		this.name = "KeyNotFoundError";
	}
}

export class DuplicateKeyError extends Error {
	constructor(key: string) {
		super(`DuplicateKey: An entry already exists for key: ${key}`);
		this.name = "DuplicateKeyError";
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SEGMENT_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const MAX_KEY_SEGMENTS = 16;
const MAX_KEY_LENGTH = 512;
const MAX_VALUE_BYTES = 1_048_576; // 1 MiB

function validateKey(key: string[]): string {
	if (key.length === 0) {
		throw new InvalidKeyError("<empty>");
	}
	if (key.length > MAX_KEY_SEGMENTS) {
		throw new InvalidKeyError(`key has ${key.length} segments, max is ${MAX_KEY_SEGMENTS}`);
	}
	for (const segment of key) {
		if (!SEGMENT_RE.test(segment)) {
			throw new InvalidKeyError(segment);
		}
	}
	const joined = key.join(":");
	if (joined.length > MAX_KEY_LENGTH) {
		throw new InvalidKeyError(`key length ${joined.length} exceeds max ${MAX_KEY_LENGTH}`);
	}
	return joined;
}

function validateNamespace(name: string): string {
	if (!SEGMENT_RE.test(name)) {
		throw new InvalidNamespaceError(name);
	}
	return name;
}

function serializeValue(value: { [key: string]: any }): string {
	const serialized = JSON.stringify(value);
	if (new TextEncoder().encode(serialized).length > MAX_VALUE_BYTES) {
		throw new RangeError(`Value size exceeds max ${MAX_VALUE_BYTES} bytes`);
	}
	return serialized;
}

// ---------------------------------------------------------------------------
// Namespace policy
// ---------------------------------------------------------------------------

export interface NamespacePolicy {
	allowlist?: string[];
	maxNamespaces?: number;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KVRow {
	key: string;
	value: unknown;
	created_at: Date;
	updated_at: Date;
}

export interface ListResult {
	rows: { key: string; value: any; created_at?: Date; updated_at?: Date }[];
	cursor: string | null;
}

export interface ListOptions {
	limit: number;
	cursor?: string;
	prefix?: string[];
	order?: "asc" | "desc";
	includeMeta?: boolean;
}

// ---------------------------------------------------------------------------
// TurokvNamespace
// ---------------------------------------------------------------------------

class TurokvNamespace {
	private initPromise: Promise<void> | null = null;

	constructor(
		public db: Client,
		public namespace: string,
	) {
		validateNamespace(namespace);
	}

	// Lazy, idempotent table initialization with a single promise lock.
	private init(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = this._createTable();
		}
		return this.initPromise;
	}

	private async _createTable(): Promise<void> {
		await this.db.executeMultiple(`
			CREATE TABLE IF NOT EXISTS ${this.namespace} (
				key        TEXT PRIMARY KEY,
				value      TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ${this.namespace}_updated_at_idx
				ON ${this.namespace}(updated_at);
		`);
	}

	// throws DuplicateKeyError if key already exists
	async put(
		inputKey: string[],
		value: { [key: string]: any },
		options?: { created_at?: Date; updated_at?: Date },
	): Promise<void> {
		await this.init();
		const key = validateKey(inputKey);
		const serialized = serializeValue(value);
		const now = Date.now();
		const createdAt = options?.created_at?.getTime() ?? now;
		const updatedAt = options?.updated_at?.getTime() ?? now;
		try {
			await this.db.execute({
				sql: `INSERT INTO ${this.namespace} (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)`,
				args: [key, serialized, createdAt, updatedAt],
			});
		} catch (err: any) {
			if (
				err?.message?.includes("UNIQUE constraint failed") ||
				err?.message?.includes("SQLITE_CONSTRAINT")
			) {
				throw new DuplicateKeyError(key);
			}
			throw err;
		}
	}

	async get(inputKey: string[]): Promise<KVRow | null> {
		await this.init();
		const key = validateKey(inputKey);
		const result = await this.db.execute({
			sql: `SELECT key, value, created_at, updated_at FROM ${this.namespace} WHERE key = ?`,
			args: [key],
		});
		const row = result.rows[0] as unknown as
			| { key: string; value: string; created_at: number; updated_at: number }
			| undefined;
		if (!row) return null;
		return {
			key: row.key,
			value: JSON.parse(row.value),
			created_at: new Date(row.created_at),
			updated_at: new Date(row.updated_at),
		};
	}

	async update(inputKey: string[], value: { [key: string]: any }): Promise<void> {
		await this.init();
		const key = validateKey(inputKey);
		const serialized = serializeValue(value);
		const result = await this.db.execute({
			sql: `UPDATE ${this.namespace} SET value = ?, updated_at = ? WHERE key = ?`,
			args: [serialized, Date.now(), key],
		});
		if (result.rowsAffected === 0) {
			throw new KeyNotFoundError(key);
		}
	}

	async delete(inputKey: string[]): Promise<void> {
		await this.init();
		const key = validateKey(inputKey);
		await this.db.execute({
			sql: `DELETE FROM ${this.namespace} WHERE key = ?`,
			args: [key],
		});
	}

	// Insert-or-replace semantics: preserves created_at if row exists.
	async set(inputKey: string[], value: { [key: string]: any }): Promise<void> {
		await this.init();
		const key = validateKey(inputKey);
		const serialized = serializeValue(value);
		const now = Date.now();
		// Use INSERT OR REPLACE but keep original created_at via coalesce subquery.
		await this.db.execute({
			sql: `INSERT OR REPLACE INTO ${this.namespace} (key, value, created_at, updated_at)
				VALUES (?, ?, COALESCE((SELECT created_at FROM ${this.namespace} WHERE key = ?), ?), ?)`,
			args: [key, serialized, key, now, now],
		});
	}

	// Returns true without parsing the JSON value.
	async exists(inputKey: string[]): Promise<boolean> {
		await this.init();
		const key = validateKey(inputKey);
		const result = await this.db.execute({
			sql: `SELECT 1 FROM ${this.namespace} WHERE key = ? LIMIT 1`,
			args: [key],
		});
		return result.rows.length > 0;
	}

	// Merges partialValue into existing value (shallow merge).
	async patch(inputKey: string[], partialValue: { [key: string]: any }): Promise<void> {
		await this.init();
		const key = validateKey(inputKey);
		const existing = await this.get(inputKey);
		if (!existing) {
			throw new KeyNotFoundError(key);
		}
		const merged = { ...(existing.value as object), ...partialValue };
		await this.update(inputKey, merged);
	}

	async list(options: ListOptions): Promise<ListResult> {
		await this.init();
		const limit = options.limit;
		const cursor = options.cursor ?? null;
		const order = options.order ?? "asc";
		const includeMeta = options.includeMeta ?? false;
		const prefix = options.prefix;

		const cols = includeMeta ? `key, value, created_at, updated_at` : `key, value`;

		const orderDir = order === "asc" ? "ASC" : "DESC";
		const cursorOp = order === "asc" ? ">" : "<";

		// Build WHERE clauses
		const conditions: string[] = [];
		const args: any[] = [];

		if (prefix && prefix.length > 0) {
			const prefixStr = prefix.join(":");
			// Match prefix exactly or as a parent segment (prefix: or exact)
			conditions.push(`(key = ? OR key LIKE ?)`);
			args.push(prefixStr, `${prefixStr}:%`);
		}

		if (cursor) {
			conditions.push(`key ${cursorOp} ?`);
			args.push(cursor);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		args.push(limit + 1);

		const result = await this.db.execute({
			sql: `SELECT ${cols} FROM ${this.namespace} ${where} ORDER BY key ${orderDir} LIMIT ?`,
			args,
		});

		const rows = result.rows as unknown as {
			key: string;
			value: string;
			created_at?: number;
			updated_at?: number;
		}[];

		const hasMore = rows.length > limit;
		const page = hasMore ? rows.slice(0, limit) : rows;

		return {
			rows: page.map((row) => ({
				key: row.key,
				value: JSON.parse(row.value),
				...(includeMeta
					? {
							created_at: new Date(row.created_at!),
							updated_at: new Date(row.updated_at!),
						}
					: {}),
			})),
			cursor: hasMore ? (page.at(page.length - 1)?.key ?? null) : null,
		};
	}

	// Batch put — all-or-nothing within a transaction.
	async putMany(entries: { key: string[]; value: { [key: string]: any } }[]): Promise<void> {
		await this.init();
		const now = Date.now();
		const stmts = entries.map(({ key: inputKey, value }) => {
			const key = validateKey(inputKey);
			const serialized = serializeValue(value);
			return {
				sql: `INSERT INTO ${this.namespace} (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)`,
				args: [key, serialized, now, now],
			};
		});
		await this.db.batch(stmts, "write");
	}

	// Batch delete — all-or-nothing within a transaction.
	async deleteMany(keys: string[][]): Promise<void> {
		await this.init();
		const stmts = keys.map((inputKey) => {
			const key = validateKey(inputKey);
			return {
				sql: `DELETE FROM ${this.namespace} WHERE key = ?`,
				args: [key],
			};
		});
		await this.db.batch(stmts, "write");
	}

	// Run multiple operations atomically.
	async transaction(fn: (ns: TurokvNamespaceTransaction) => Promise<void>): Promise<void> {
		await this.init();
		const tx = new TurokvNamespaceTransaction(this.namespace);
		await fn(tx);
		await this.db.batch(tx._stmts, "write");
	}
}

// ---------------------------------------------------------------------------
// Transaction helper — accumulates statements, flushed atomically by transaction()
// ---------------------------------------------------------------------------

class TurokvNamespaceTransaction {
	_stmts: { sql: string; args: any[] }[] = [];

	constructor(private namespace: string) {}

	put(inputKey: string[], value: { [key: string]: any }): void {
		const key = validateKey(inputKey);
		const serialized = serializeValue(value);
		const now = Date.now();
		this._stmts.push({
			sql: `INSERT INTO ${this.namespace} (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)`,
			args: [key, serialized, now, now],
		});
	}

	delete(inputKey: string[]): void {
		const key = validateKey(inputKey);
		this._stmts.push({
			sql: `DELETE FROM ${this.namespace} WHERE key = ?`,
			args: [key],
		});
	}
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface ClientOptions {
	namespacePolicy?: NamespacePolicy;
}

export function newClient(db: Client, options?: ClientOptions) {
	const policy = options?.namespacePolicy;
	const activeNamespaces = new Set<string>();

	return {
		namespace(name: string): TurokvNamespace {
			validateNamespace(name);

			if (policy?.allowlist && !policy.allowlist.includes(name)) {
				throw new InvalidNamespaceError(`${name} is not in the namespace allowlist`);
			}

			activeNamespaces.add(name);

			if (policy?.maxNamespaces !== undefined && activeNamespaces.size > policy.maxNamespaces) {
				activeNamespaces.delete(name);
				throw new RangeError(`Namespace limit of ${policy.maxNamespaces} reached`);
			}

			return new TurokvNamespace(db, name);
		},
	};
}
