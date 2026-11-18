export function autoFill(batches, needed) {
  let left = needed;
  const picked = {};
  for (const b of batches) {
    if (b.expired || left <= 0) continue;
    const take = Math.min(b.qty_units, left);
    if (take > 0) picked[b.id] = String(take);
    left -= take;
  }
  return { picked, short: Math.max(left, 0) };
}
