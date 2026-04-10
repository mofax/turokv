# turokv

A lightweight key-value store built on top of [libSQL](https://github.com/tursodatabase/libsql). Keys are structured as string segments (e.g. `["users", "alice"]`), and values are arbitrary JSON objects. Data is organized into named namespaces, each backed by a separate table.

## Installation

```bash
bun install
```

`@libsql/client` is a peer dependency — install it alongside turokv:

```bash
bun add @libsql/client
```

## Usage

```ts
import { createClient } from "@libsql/client";
import { newClient } from "./lib/client";

const db = createClient({ url: "file:local.db" });
const client = newClient(db);

const users = client.namespace("users");
```

### `put(key, value)`

Inserts a new entry. Throws if the key already exists — use `update` to modify an existing entry.

```ts
await users.put(["alice"], { email: "alice@example.com", role: "admin" });
```

### `get(key)`

Returns the entry, or `null` if not found.

```ts
const entry = await users.get(["alice"]);
// { key: "alice", value: { email: "...", role: "..." }, created_at: Date, updated_at: Date }
```

### `update(key, value)`

Replaces the value for an existing key. Throws `KeyNotFound` if the key does not exist.

```ts
await users.update(["alice"], { email: "alice@example.com", role: "owner" });
```

### `delete(key)`

Deletes an entry by key.

```ts
await users.delete(["alice"]);
```

### `list(options)`

Paginates over entries in ascending key order. Pass the returned `cursor` to fetch the next page.

```ts
const page1 = await users.list({ limit: 20 });
// { rows: [{ key, value }, ...], cursor: "alice" | null }

const page2 = await users.list({ limit: 20, cursor: page1.cursor });
```

## Keys

Keys are arrays of one or more string segments joined with `:`. Each segment must start with a letter and contain only letters, numbers, and underscores.

```ts
["users", "alice"][("orgs", "acme", "admins")]; // → "users:alice" // → "orgs:acme:admins"
```

## Namespaces

Each namespace maps to a database table. Namespace names follow the same rules as key segments.

```ts
const users = client.namespace("users");
const events = client.namespace("events");
```
