// ── Shared Logger for all sync services ─────────────────────────────────────

export function createLogger(prefix) {
  return {
    log: (module, ...args) => console.log(`[${prefix}] [${module}]`, ...args),
    error: (module, ...args) => console.error(`[${prefix}] [${module}]`, ...args),
  };
}
