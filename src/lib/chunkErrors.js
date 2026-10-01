const CHUNK_ERRORS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Unable to preload CSS/i,
];

export const isChunkLoadError = (err) => {
  const msg = String(err?.message || err || "");
  return CHUNK_ERRORS.some((pattern) => pattern.test(msg));
};
