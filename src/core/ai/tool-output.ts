/**
 * Convert arbitrary tool results into deterministic JSON-safe values.
 *
 * This runs before durable persistence and again at provider boundaries so a
 * live turn and its crash replay cannot diverge. Object properties containing
 * unsupported JSON values are omitted; array positions become null.
 */
export function normalizeToolOutput(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map(item => normalizeToolOutput(item, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested === undefined || typeof nested === 'function' || typeof nested === 'symbol') continue;
      out[key] = normalizeToolOutput(nested, seen);
    }
    return out;
  } catch {
    return String(value);
  } finally {
    seen.delete(value);
  }
}
