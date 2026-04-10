# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # install dependencies
bun fmt              # format with oxfmt
bun lint             # lint with oxlint
bun run test/run.ts  # run the test script
```

## Architecture

turokv is a small key-value store library wrapping [libSQL](https://github.com/tursodatabase/libsql). The entire implementation lives in [lib/client.ts](lib/client.ts).

**Core abstractions:**

- `newClient(db)` — accepts a `@libsql/client` `Client` instance and returns a thin wrapper with a single `namespace(name)` method.
- `TurokvNamespace` — the main class. Each namespace maps 1:1 to a SQLite table. Exposes `put`, `get`, `update`, `delete`, and `list`.

**Key design details:**

- Keys are `string[]` segments joined with `:` (e.g. `["users", "alice"]` → `"users:alice"`). Both keys and namespace names are validated with the same regex: must start with a letter, only letters/numbers/underscores.
- Values are stored as `JSON.stringify`'d blobs; `get` and `list` parse them back.
- `list` uses cursor-based pagination: it fetches `limit + 1` rows to detect a next page, using the last key of the current page as the cursor.
- SQL is built with the `tpl-sql` template-literal library via `SQL("sqlite")`.
- `@libsql/client` is a peer dependency — consumers must install it themselves.

**Error conventions:** `put` throws on duplicate key (SQLite unique constraint). `update` throws `KeyNotFound` if `rowsAffected === 0`. `delete` is silent if the key doesn't exist.
