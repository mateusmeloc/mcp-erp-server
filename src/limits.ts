// Sliding-window limiter, in memory. Good for a single instance (what this demo is); see the
// README for what to change when running several replicas.

export interface WindowLimiter {
  /** Returns null when allowed, or the seconds to wait when the limit is hit. */
  hit(key: string): number | null;
}

export function createWindowLimiter(opts: { max: number; windowMs: number; now?: () => number }): WindowLimiter {
  const now = opts.now ?? Date.now;
  const marks = new Map<string, number[]>();
  return {
    hit(key) {
      const t = now();
      const recent = (marks.get(key) ?? []).filter((x) => t - x < opts.windowMs);
      if (recent.length >= opts.max) {
        marks.set(key, recent);
        return Math.max(1, Math.ceil((opts.windowMs - (t - (recent[0] ?? t))) / 1000));
      }
      recent.push(t);
      marks.set(key, recent);
      if (marks.size > 5000) for (const [k, v] of marks) if (v.every((x) => t - x >= opts.windowMs)) marks.delete(k);
      return null;
    },
  };
}
