import type { Selectable } from "kysely";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { SqliteSessionOwnerRow } from "./session-accessor.sqlite-owner-projection.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_nodes"]>;

export type ResolvedSessionEntryRow = {
  entry: InternalSessionEntry;
  row: Pick<SessionEntryRow, "current_session_id" | "entry_json" | "session_key" | "updated_at"> &
    SqliteSessionOwnerRow & { rowid?: string } & Partial<
      Pick<SessionEntryRow, "legacy_acp_migration_json">
    >;
};

export type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type SessionEntryCacheReadOptions = {
  cache: boolean;
  latest?: boolean;
  projection?: "full" | "list";
  /** Stream full JSON once, retaining prompt snapshots only for selected rows. Never cached. */
  retainFullEntry?: (sessionKey: string, entry: SessionEntry) => boolean;
  /** Topology admits metadata first; its worker owns participant hydration. Never cache this view. */
  deferParticipants?: true;
};

export type SessionEntryCacheSnapshot = {
  entries: Map<string, SessionEntry>;
  keys: string[];
};

export type SessionSharingEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "updatedAt"
  | "lifecycleRevision"
  | "archivedAt"
  | "visibility"
  | "incognito"
  | "createdActor"
  | "owner"
  | "sandbox"
  | "spawnedBy"
  | "parentSessionKey"
  | "sessionStartedAt"
>;

export function projectSessionSharingEntry(entry: SessionEntry): SessionSharingEntry {
  return {
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
    lifecycleRevision: entry.lifecycleRevision,
    archivedAt: entry.archivedAt,
    visibility: entry.visibility,
    incognito: entry.incognito,
    createdActor: entry.createdActor ? { ...entry.createdActor } : undefined,
    owner: entry.owner
      ? {
          ...entry.owner,
          actor: { ...entry.owner.actor },
          assignedBy: entry.owner.assignedBy ? { ...entry.owner.assignedBy } : undefined,
        }
      : undefined,
    sandbox: entry.sandbox,
    spawnedBy: entry.spawnedBy,
    parentSessionKey: entry.parentSessionKey,
    sessionStartedAt: entry.sessionStartedAt,
  };
}

export type SessionEntryPlaceholder = Readonly<{ sessionId: string }>;

export type SessionTranscriptInitializationPublication = {
  kind: "session-transcript-initialized";
  sessionKey: string;
  placeholder?: SessionEntryPlaceholder;
};

export type SessionEntryReplacementPublication = {
  kind: "session-entry-replacements";
  pendingArchiveRecovery: boolean;
  previous: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision">>;
  current: Map<string, SessionSharingEntry>;
  changedKeys: string[];
  membershipInvalidatedKeys: string[];
};

const creationBrand = Symbol("sessionEntryCreation");
export type SessionEntryCreationOperation = Readonly<{ [creationBrand]: true }>;

/** Allocate an opaque token; the publication owner's WeakMap alone grants live custody. */
export function createSessionEntryCreationOperation(): SessionEntryCreationOperation {
  return Object.freeze({ [creationBrand]: true });
}
