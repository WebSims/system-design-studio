import { migrateAndParseStudy, StudySchema, type Study } from "@sds/schema";

/**
 * Persistence: studies in IndexedDB, the active pointer in local storage.
 *
 * WHY THE SPLIT
 *
 * A study with seven candidates and their cached evaluations is megabytes. Local storage has a
 * few, is synchronous, and is shared with everything else the origin stores -- so a study that
 * grew past the quota would fail to save, silently, on the write after the one that worked. The
 * failure mode is losing an afternoon of exploration and finding out later.
 *
 * IndexedDB is asynchronous and has room. What stays in local storage is one string: which study
 * is open. That is the one piece of state that has to be readable synchronously at startup, and
 * it cannot grow.
 *
 * WHY EVERY READ GOES THROUGH THE MIGRATOR
 *
 * A stored study may have been written by an older build. Parsing it with the current schema
 * would throw on a version mismatch and the app would open empty, which is the worst possible
 * response to "your saved work is slightly old". So every read migrates, and a read that cannot
 * be migrated is reported as a named failure rather than as an absence -- because "no study
 * found" and "your study could not be read" call for very different reactions from the user.
 */

const DB_NAME = "sds";
const DB_VERSION = 1;
const STORE = "studies";
const ACTIVE_KEY = "sds.activeStudy.v1";

/**
 * Project ids that old builds created as product demos.
 *
 * The model still exists as an internal engine fixture, but it is not a user project and must not
 * reappear in saved-study results or active restore after repository-first onboarding. Match the
 * stable id rather than the display name so an unrelated user project is never swept up.
 */
const RETIRED_DEVELOPMENT_STUDY_IDS = new Set(["limited-free-pizza"]);

export function isRetiredDevelopmentStudyId(id: string): boolean {
  return RETIRED_DEVELOPMENT_STUDY_IDS.has(id);
}

export interface StoredStudy {
  id: string;
  name: string;
  problem: string;
  updatedAt: number;
  candidateCount: number;
  /** Any version drawn by an agent, so the list can carry the same mark the versions strip does. */
  hasAgentVersions: boolean;
}

/** The list row for a study document, the one place its summary is computed. */
export function summariseStored(study: Study): StoredStudy {
  return {
    id: study.id,
    name: study.name,
    problem: study.problem,
    updatedAt: study.updatedAt,
    candidateCount: study.candidates.length,
    hasAgentVersions: study.candidates.some((candidate) => candidate.origin === "agent"),
  };
}

export type LoadResult =
  | { status: "ok"; study: Study }
  | { status: "missing" }
  | { status: "unreadable"; reason: string };

/**
 * The IndexedDB handle, opened lazily and once.
 *
 * Not opened at module load: a module that opens a database as a side effect of being imported
 * cannot be imported by a test, and the layout logic in this app is unit-tested in node.
 */
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this browser has no IndexedDB, so projects cannot be saved"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open project storage"));
    // Private-browsing modes and a full disk both surface here rather than as an error, and both
    // mean the same thing to the user: this session will not be saved.
    request.onblocked = () => reject(new Error("project storage is blocked by another tab"));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("project storage failed"));
      })
  );
}

export async function saveStudy(study: Study): Promise<void> {
  // Parsed on the way out as well as on the way in. A store that only validated on read would
  // accept a malformed study now and fail to open it later, which converts a bug in the app into
  // apparent data loss.
  const validated = StudySchema.parse({ ...study, updatedAt: Date.now() });
  await tx("readwrite", (store) => store.put(validated as unknown as Record<string, unknown>));
}

export async function loadStudy(id: string): Promise<LoadResult> {
  if (isRetiredDevelopmentStudyId(id)) return { status: "missing" };
  let raw: unknown;
  try {
    raw = await tx<unknown>("readonly", (store) => store.get(id) as IDBRequest<unknown>);
  } catch (err) {
    return { status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (raw === undefined || raw === null) return { status: "missing" };
  try {
    return { status: "ok", study: migrateAndParseStudy(raw) };
  } catch (err) {
    // Named, not swallowed. "Your study could not be read" needs a different reaction from the
    // user than "no study found", and conflating them loses work quietly.
    return {
      status: "unreadable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listStudies(): Promise<StoredStudy[]> {
  try {
    const all = await tx<unknown[]>("readonly", (store) => store.getAll() as IDBRequest<unknown[]>);
    const out: StoredStudy[] = [];
    for (const raw of all) {
      const rawId = (raw as { id?: unknown } | null)?.id;
      if (typeof rawId === "string" && isRetiredDevelopmentStudyId(rawId)) continue;
      // Each entry is summarised independently, so one unreadable study does not hide the rest.
      try {
        out.push(summariseStored(migrateAndParseStudy(raw)));
      } catch {
        const partial = raw as { id?: unknown; name?: unknown };
        if (typeof partial.id === "string") {
          out.push({
            id: partial.id,
            name: typeof partial.name === "string" ? `${partial.name} (unreadable)` : "(unreadable)",
            problem: "",
            updatedAt: 0,
            candidateCount: 0,
            hasAgentVersions: false,
          });
        }
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function deleteStudy(id: string): Promise<void> {
  await tx("readwrite", (store) => store.delete(id) as unknown as IDBRequest<undefined>);
}

/** Remove exact legacy demo records without touching user-created projects. */
export async function removeRetiredDevelopmentStudies(): Promise<void> {
  await Promise.all([...RETIRED_DEVELOPMENT_STUDY_IDS].map((id) => deleteStudy(id)));
}

// ---------------------------------------------------------------------------
// the active pointer
// ---------------------------------------------------------------------------

export function readActiveStudyId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    // Storage access can throw outright under some privacy settings. Treated as "nothing open",
    // which is correct and which lets the app start.
    return null;
  }
}

export function writeActiveStudyId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // Swallowed deliberately: failing to remember which study was open is a small annoyance, and
    // throwing here would break an edit that had otherwise succeeded.
  }
}

// ---------------------------------------------------------------------------
// interface preferences
// ---------------------------------------------------------------------------

/**
 * Small, non-document preferences: where a pane is docked, whether it is collapsed. Local storage
 * is right for these because they are a few bytes, wanted synchronously at first render, and
 * losing them costs one click. `parse` is the caller's validator, so a stale or hand-edited value
 * falls back to the default rather than reaching the interface.
 */
export function readUiPref<T>(key: string, fallback: T, parse: (raw: unknown) => T | null): T {
  try {
    const raw = localStorage.getItem(`sds.ui.${key}`);
    if (raw === null) return fallback;
    return parse(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeUiPref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`sds.ui.${key}`, JSON.stringify(value));
  } catch {
    // A preference that does not stick is one click of inconvenience, not an error worth showing.
  }
}

// ---------------------------------------------------------------------------
// import and export
// ---------------------------------------------------------------------------

/** File extension for a study document, distinct from a design's `.sds.json`. */
export const STUDY_EXTENSION = ".sds-project.json";

export function exportStudy(study: Study): string {
  return JSON.stringify(StudySchema.parse(study), null, 2);
}

/**
 * Import a study or a design.
 *
 * A design file is accepted and becomes a one-candidate study with no correctness contract, which
 * is what `migrateAndParseStudy` does. That is the whole migration story for existing users:
 * their saved designs open, unchanged, and gain the ability to have candidates added beside them.
 */
export function importStudy(json: string): Study {
  return migrateAndParseStudy(JSON.parse(json));
}

export function studyFilename(study: Study): string {
  const slug = study.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "project"}${STUDY_EXTENSION}`;
}
