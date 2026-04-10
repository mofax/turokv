# turokv Missing-Feature Audit (Actionable)

## Critical Gaps (fix first)

### 1) No table lifecycle management (library is not self-bootstrapping)

**Current state**

- `namespace(name)` returns a wrapper, but never creates/verifies the underlying table.
- All CRUD/list operations assume the table already exists.

**Impact**

- First write/read on a new namespace fails with SQL errors unless consumers manually create tables out-of-band.
- This breaks "small KV wrapper" expectations.

**Action**

- Add lazy, idempotent table initialization inside `TurokvNamespace` before any operation.
- Use a single promise lock (`this.initPromise`) to avoid duplicate initialization under concurrency.

**Proposed API/behavior**

- Keep existing API, but internally run:
  - `CREATE TABLE IF NOT EXISTS <namespace> (...)`
  - `CREATE INDEX IF NOT EXISTS <namespace>_updated_at_idx ON <namespace>(updated_at)`

**Acceptance criteria**

- New namespace works without user-created DDL.
- Parallel `put/get/list` calls on a fresh namespace do not race/fail.

---

### 2) Package entrypoint is inconsistent

**Current state**

- `package.json` points `"module": "index.ts"`, but repo has no `index.ts`.
- README examples import from `./lib/client`, not package root.

**Impact**

- Consumers cannot reliably import from package root.

**Action**

- Add `index.ts` exporting `newClient` and types.
- Update `package.json` to proper export map.

**Proposed package fields**

- `"exports": { ".": "./index.ts" }` (or built output equivalent)
- `"types"` field once emit pipeline exists.

**Acceptance criteria**

- `import { newClient } from "turokv"` works in a fresh consumer project.

---

### 3) No real test coverage

**Current state**

- `test/run.ts` is not testing `turokv`; it just opens a local DB and writes to a demo table.
- No assertions for CRUD, pagination, errors, or validation.

**Impact**

- Regressions are invisible.
- Missing features cannot be delivered safely.

**Action**

- Replace with Bun test suite that covers:
  - key/namespace validation
  - `put/get/update/delete`
  - duplicate-key failure behavior
  - `update` not-found behavior
  - cursor pagination correctness
  - JSON serialization roundtrip

**Acceptance criteria**

- CI-style command (`bun test`) passes and catches intentional regressions.

## High-Value Missing Features

### 4) Missing upsert and existence checks

**Why**

- Many KV workflows need "set regardless of existence" and "exists?" without full payload fetch.

**Action**

- Add `set(key, value)` (insert-or-replace semantics preserving `created_at` if row exists).
- Add `exists(key): Promise<boolean>`.

**Acceptance criteria**

- `set` works for both create/update paths.
- `exists` uses `SELECT 1` and avoids JSON parse overhead.

---

### 5) Missing partial updates / patch semantics

**Why**

- `update` replaces whole object; callers must read-modify-write externally.

**Action**

- Add `patch(key, partialValue, options?)`.
- Start with app-level merge (JS object merge) + rewrite value; move to JSON SQL ops later if needed.

**Acceptance criteria**

- Patch updates targeted fields and preserves unrelated keys.

---

### 6) Limited list API (no prefix scan / reverse / projection)

**Why**

- Segment keys imply hierarchical traversal; current API cannot query by prefix (`users:*`) or reverse order.

**Action**

- Extend `list` options:
  - `prefix?: string[]`
  - `order?: "asc" | "desc"`
  - `includeMeta?: boolean`

**Acceptance criteria**

- Prefix paging is stable and cursor-safe.
- Reverse traversal works with cursor continuation.

## Reliability and DX Improvements

### 7) No typed error surface

**Current state**

- Throws generic `Error` strings (`InvalidKey: ...`, `KeyNotFound: ...`).

**Action**

- Add explicit error classes:
  - `InvalidKeyError`
  - `InvalidNamespaceError`
  - `KeyNotFoundError`
  - `DuplicateKeyError` (map libSQL unique-constraint error)

**Acceptance criteria**

- Consumers can `instanceof` and branch safely.

---

### 8) No transaction API for multi-key operations

**Why**

- Real apps need atomic updates across multiple keys.

**Action**

- Add `namespace.transaction(fn)` that exposes scoped ops bound to one SQL transaction.
- At minimum, add batch methods (`putMany`, `deleteMany`) with transactional behavior.

**Acceptance criteria**

- Partial failure rolls back all writes.

---

### 9) Missing metadata access in list results

**Current state**

- `get` returns timestamps; `list` drops `created_at/updated_at`.

**Action**

- Add optional metadata inclusion in `list`.

**Acceptance criteria**

- `list({ includeMeta: true })` returns timestamps consistently with `get`.

## Security / Data Integrity Gaps

### 10) Unbounded payload and key sizes

**Risk**

- Very large JSON blobs or pathological keys can cause memory/perf issues.

**Action**

- Add configurable limits:
  - max key segments
  - max key length
  - max serialized value bytes

**Acceptance criteria**

- Deterministic validation errors before DB write.

---

### 11) No guardrails for unsafe namespace proliferation

**Risk**

- Namespace = table model can create unbounded tables, hurting SQLite performance and maintenance.

**Action**

- Add optional namespace policy at client creation:
  - allowlist
  - max namespace count
  - optional "single-table mode" (future: composite PK `namespace + key`)

**Acceptance criteria**

- Consumer can prevent uncontrolled table creation.

## Recommended Execution Plan

1. **Week 1 (stability)**
   - Implement table initialization lock.
   - Fix package entrypoint.
   - Replace test harness with real tests.

2. **Week 2 (core feature parity)**
   - Add `set`, `exists`, `patch`.
   - Expand `list` options with prefix scan + metadata.

3. **Week 3 (hardening)**
   - Typed errors.
   - Limits/policies.
   - Transaction/batch APIs.

## Suggested First PR Scope (small but high leverage)

- Table auto-init + init-lock
- `exists(key)`
- test suite for current API + new `exists`
- package root export fix

This scope closes the biggest reliability gaps with minimal API churn and establishes a safe base for feature expansion.
