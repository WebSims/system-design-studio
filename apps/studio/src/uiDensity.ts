export type UiDensity = "guided" | "expert";

const STORAGE_KEY = "sds-ui-density-v1";

/** New installations are deliberately guided; experts can opt into denser evidence detail. */
export function readUiDensity(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): UiDensity {
  try {
    return storage?.getItem(STORAGE_KEY) === "expert" ? "expert" : "guided";
  } catch {
    return "guided";
  }
}

export function writeUiDensity(value: UiDensity, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, value);
  } catch {
    // A privacy-restricted browser may reject localStorage. The in-memory setting still works.
  }
}
