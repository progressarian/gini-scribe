export function computeDashboard(rows, ctx) {
  const W = ctx.windows.length;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = (s.length - 1) / 2;
    return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
  };
  const share = (n, d) => ({ n, d, pct: d ? (n / d) * 100 : null });
  const bit = (mask, i) => (mask & (1 << i)) !== 0;
  const band = (v) => ctx.severity.findIndex((b) => v >= b.min && v < b.max);

  const outcome = (pairs) => {
    const ch = pairs.map(([b, f]) => Math.round((f - b) * 100) / 100);
    const above = pairs.filter(([b]) => b >= 7);
    const below = pairs.filter(([b]) => b < 7);
    return {
      n: pairs.length,
      baseline_mean: mean(pairs.map((p) => p[0])),
      follow_mean: mean(pairs.map((p) => p[1])),
      change_mean: mean(ch),
      change_median: median(ch),
      any_improvement: share(ch.filter((c) => c < 0).length, pairs.length),
      improved_05: share(ch.filter((c) => c <= -0.5).length, pairs.length),
      improved_10: share(ch.filter((c) => c <= -1.0).length, pairs.length),
      worsened_05: share(ch.filter((c) => c >= 0.5).length, pairs.length),
      below7: share(pairs.filter(([, f]) => f < 7).length, pairs.length),
      reached_below7: share(above.filter(([, f]) => f < 7).length, above.length),
      maintained_below7: share(below.filter(([, f]) => f < 7).length, below.length),
    };
  };

  const pairsAt = (list, key, i) =>
    list
      .filter((r) => bit(r.e, i) && r[key] && r[key][i + 1] != null)
      .map((r) => [r[key][0], r[key][i + 1]]);

  const hba1c = ctx.windows.map((w, i) => {
    const eligible = rows.filter((r) => bit(r.e, i));
    const withBase = eligible.filter((r) => r.hb);
    const pairs = pairsAt(rows, "hb", i);
    return {
      window: w.key,
      label: w.label,
      range: [w.minDays, w.maxDays],
      eligible: eligible.length,
      too_recent: rows.length - eligible.length,
      with_baseline: withBase.length,
      measured: share(pairs.length, withBase.length),
      outcome: outcome(pairs),
      by_severity: ctx.severity.map((b, k) => ({
        band: b.label,
        ...outcome(pairs.filter(([base]) => band(base) === k)),
      })),
    };
  });

  const change = (key, i) => {
    const eligible = rows.filter((r) => bit(r.e, i) && r[key]);
    const pairs = pairsAt(rows, key, i);
    const ch = pairs.map(([b, f]) => f - b);
    return {
      with_baseline: eligible.length,
      n: pairs.length,
      baseline_mean: mean(pairs.map((p) => p[0])),
      follow_mean: mean(pairs.map((p) => p[1])),
      change_mean: mean(ch),
      change_median: median(ch),
    };
  };
  const markers = ["wt", "bp", "ldl"].map((key) => ({
    key,
    windows: [1, 2, 3].map((i) => ({ window: ctx.windows[i].label, ...change(key, i) })),
  }));

  const counts = (key, labels) =>
    labels.map((label, i) => ({
      label,
      ...share(rows.filter((r) => r[key] === i).length, rows.length),
    }));
  const years = [...new Set(rows.map((r) => r.y))].sort();

  const retention = years.map((y) => {
    const cohort = rows.filter((r) => r.y === y);
    return {
      year: y,
      enrolled: cohort.length,
      windows: [0, 1, 2, 3].map((i) => {
        const el = cohort.filter((r) => bit(r.e, i));
        return share(el.filter((r) => bit(r.rv, i)).length, el.length);
      }),
    };
  });

  const completeness = years.map((y) => ({
    year: y,
    windows: ctx.windows.map((w, i) => {
      const el = rows.filter((r) => r.y === y && bit(r.e, i) && r.hb);
      return share(el.filter((r) => r.hb[i + 1] != null).length, el.length);
    }),
  }));

  const profile = (list) => ({
    n: list.length,
    female: share(list.filter((r) => r.s === 0).length, list.length),
    baseline: mean(list.map((r) => r.hb[0])),
    visits: median(list.map((r) => r.v)),
    type1: share(list.filter((r) => r.t === 1).length, list.length),
    age60: share(list.filter((r) => r.a >= 3).length, list.filter((r) => r.a >= 0).length),
  });
  const bias = [1, 2].map((i) => {
    const el = rows.filter((r) => bit(r.e, i) && r.hb);
    return {
      window: ctx.windows[i].label,
      measured: profile(el.filter((r) => r.hb[i + 1] != null)),
      missing: profile(el.filter((r) => r.hb[i + 1] == null)),
    };
  });

  const complete = rows.filter((r) => r.c.every((v) => v != null));
  const control = {
    population: rows.length,
    complete: share(complete.length, rows.length),
    hba1c: share(complete.filter((r) => r.c[0] === 1).length, complete.length),
    bp: share(complete.filter((r) => r.c[1] === 1).length, complete.length),
    ldl: share(complete.filter((r) => r.c[2] === 1).length, complete.length),
    all: share(complete.filter((r) => r.c.every((v) => v === 1)).length, complete.length),
  };

  const treatments = ctx.treatments.map((t, ti) => {
    const all = rows.filter((r) => bit(r.tx, ti));
    const fresh = rows.filter((r) => r.tr[ti]);
    return {
      label: t.label,
      prescribed: all.length,
      new_starts: fresh.length,
      windows: [0, 1, 2].map((i) => {
        const el = fresh.filter((r) => bit(r.tr[ti].e, i));
        const a = el
          .filter((r) => r.tr[ti].a && r.tr[ti].a[i + 1] != null)
          .map((r) => [r.tr[ti].a[0], r.tr[ti].a[i + 1]]);
        const w = el
          .filter((r) => r.tr[ti].w && r.tr[ti].w[i + 1] != null)
          .map((r) => [r.tr[ti].w[0], r.tr[ti].w[i + 1]]);
        return {
          window: ctx.windows[i].label,
          eligible: el.length,
          with_baseline: el.filter((r) => r.tr[ti].a).length,
          hba1c: outcome(a),
          weight: {
            n: w.length,
            change_mean: mean(w.map(([b, f]) => f - b)),
            pct_change_mean: mean(w.map(([b, f]) => ((f - b) / b) * 100)),
            lost_5pct: share(w.filter(([b, f]) => (f - b) / b <= -0.05).length, w.length),
          },
        };
      }),
    };
  });

  return {
    total: rows.length,
    funnel: {
      with_baseline: share(rows.filter((r) => r.hb).length, rows.length),
      any_hba1c: share(rows.filter((r) => r.h >= 1).length, rows.length),
      two_hba1c: share(rows.filter((r) => r.h >= 2).length, rows.length),
      single_visit: share(rows.filter((r) => r.v === 1).length, rows.length),
      three_visits: share(rows.filter((r) => r.v >= 3).length, rows.length),
      three_visits_6m: share(rows.filter((r) => r.v6).length, rows.length),
    },
    sex: counts("s", ctx.sex),
    type: counts("t", ctx.type),
    age: [
      ...counts(
        "a",
        ctx.age.map((a) => a[0]),
      ),
      { label: "Not recorded", ...share(rows.filter((r) => r.a < 0).length, rows.length) },
    ],
    status: counts("st", ctx.statusLabels),
    years: years.map((y) => ({
      label: String(y),
      ...share(rows.filter((r) => r.y === y).length, rows.length),
    })),
    hba1c,
    markers,
    retention,
    completeness,
    bias,
    control,
    treatments,
    windowCount: W,
  };
}
