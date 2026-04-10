export {
	newClient,
	InvalidKeyError,
	InvalidNamespaceError,
	KeyNotFoundError,
	DuplicateKeyError,
} from "./lib/client";

export type { KVRow, ListResult, ListOptions, NamespacePolicy, ClientOptions } from "./lib/client";
