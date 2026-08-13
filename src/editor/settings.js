// Persisted user preferences for the Add Tool (Fase 6.8 configurability).
// Kept as its own small module (rather than folding into tool-add.js)
// so the persistence concern - reading/writing localStorage, validating
// what comes back out of it - stays separate from the tool's runtime
// interaction logic.

const STORAGE_KEY = 'devoxel.addToolSettings.v1';

export const DEFAULT_PALETTE = ['#7fd4ff', '#ffb27f', '#b6ff7f', '#ff7fd4', '#7fffcf', '#d4ff7f', '#ff9f7f', '#9f7fff'];
export const DEFAULT_UNIT_SIZE = 1;
// Default: snapping ON. The unit size above is only meaningful as a snap
// increment when this is true - with it false, drag/extrude produce
// continuous (non-integer) dimensions instead of grid-aligned ones.
export const DEFAULT_SNAP_ENABLED = true;

function isValidHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

function sanitize(raw) {
  const out = { unitSize: DEFAULT_UNIT_SIZE, palette: [...DEFAULT_PALETTE], snapEnabled: DEFAULT_SNAP_ENABLED };
  if (!raw || typeof raw !== 'object') return out;

  if (Number.isFinite(raw.unitSize)) {
    out.unitSize = Math.max(1, Math.min(16, Math.round(raw.unitSize)));
  }
  if (Array.isArray(raw.palette)) {
    const cleaned = raw.palette.filter(isValidHexColor);
    if (cleaned.length > 0) out.palette = cleaned;
  }
  if (typeof raw.snapEnabled === 'boolean') {
    out.snapEnabled = raw.snapEnabled;
  }
  return out;
}

/**
 * Loads settings from localStorage. Never throws - falls back to
 * defaults on missing/corrupt/inaccessible storage (e.g. private
 * browsing mode in some browsers throws on access), so a bad or
 * hand-edited localStorage value can't break the editor on load.
 */
export function loadAddToolSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return sanitize(null);
    return sanitize(JSON.parse(raw));
  } catch {
    return sanitize(null);
  }
}

/** Persists settings to localStorage. Silently no-ops if storage is unavailable. */
export function saveAddToolSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings)));
  } catch {
    // Storage unavailable (quota exceeded, private mode, disabled) -
    // preferences just won't persist this session; not worth surfacing
    // as an error to the user for a non-critical convenience feature.
  }
}
