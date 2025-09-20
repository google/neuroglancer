/**
 * Local (per-browser) user settings persistence for Neuroglancer.
 * Stored outside sharable state/URL. Safe to extend; bump VERSION if breaking.
 */

const STORAGE_KEY = "neuroglancer_user_settings_v1";

export interface StoredSettings {
  adaptiveDownsamplingEnabled?: boolean;
  adaptiveDownsamplingTargetMs?: number; // desired frame timing
}

const DEFAULTS: Required<
  Pick<
    StoredSettings,
    "adaptiveDownsamplingEnabled" | "adaptiveDownsamplingTargetMs"
  >
> = {
  adaptiveDownsamplingEnabled: true,
  adaptiveDownsamplingTargetMs: 33,
};

function safeParse(raw: string | null): Partial<StoredSettings> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return typeof obj === "object" && obj ? obj : {};
  } catch {
    return {};
  }
}

export function loadUserSettings(): StoredSettings {
  try {
    const parsed = safeParse(window.localStorage.getItem(STORAGE_KEY));
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

let pending: Partial<StoredSettings> = {};
let saveTimer: number | undefined;
const DEBOUNCE_MS = 250;

function flush() {
  try {
    const current = safeParse(window.localStorage.getItem(STORAGE_KEY));
    const merged = { ...current, ...pending };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* ignore quota / privacy mode errors */
  } finally {
    pending = {};
    saveTimer = undefined;
  }
}

export function saveUserSettings(delta: Partial<StoredSettings>) {
  pending = { ...pending, ...delta };
  if (saveTimer === undefined) {
    saveTimer = window.setTimeout(flush, DEBOUNCE_MS);
  }
}

// Generic binder for TrackableValue-like interfaces (must expose .value and .changed signal)
export function bindTrackableToLocalStorage<T>(
  trackable: { value: T; changed: { add: (cb: () => void) => unknown } },
  key: keyof StoredSettings,
  transform?: (v: T) => any,
) {
  trackable.changed.add(() => {
    const raw = transform
      ? transform(trackable.value)
      : (trackable.value as any);
    saveUserSettings({ [key]: raw } as Partial<StoredSettings>);
  });
}
