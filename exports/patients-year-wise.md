# OPD Patients — Year-wise Summary

**Total patients in database: 17,899 · with OPD history: 16,565**
_OPD visits only (`visit_type = 'OPD'`). All-time, no date filter. Generated 2026-08-13 (2026 is a partial year — data through 13 Aug)._

## New OPD patients per year

Counted by the year of each patient's **first OPD consultation**. Every patient appears exactly once, so this column sums to the all-time total.

| Year | New patients | Running total |
| ---- | -----------: | ------------: |
| 2021 | 4 | 4 |
| 2022 | 3,299 | 3,303 |
| 2023 | 4,104 | 7,407 |
| 2024 | 2,111 | 9,518 |
| 2025 | 4,344 | 13,862 |
| 2026 (to 13 Aug) | 2,703 | 16,565 |
| **No OPD visit on record** | **1,334** | **17,899** |

_Running total = the cumulative sum: how many different patients had ever attended OPD by the end of that year._

## Active OPD patients per year

Distinct patients with at least one OPD visit that year. A patient who attends across several years is counted in **each** of them, so this column does not sum to the total.

| Year | Active patients | OPD visits | Visits per patient |
| ---- | --------------: | ---------: | -----------------: |
| 2021 | 4 | 4 | 1.0 |
| 2022 | 3,303 | 8,654 | 2.6 |
| 2023 | 5,618 | 21,813 | 3.9 |
| 2024 | 4,270 | 12,702 | 3.0 |
| 2025 | 6,298 | 43,577 | 6.9 |
| 2026 (to 13 Aug) | 5,914 | 18,181 | 3.1 |
| **All-time** | **16,565** | **104,931** | **6.3** |

## Notes

- **Excluded:** 3,448 LAB visits (sample drop-offs with no doctor consultation) and 9 Follow-up rows — 3,457 of the 108,388 total visit rows. Almost all of the excluded LAB visits fall in 2023 (3,447).
- **1,334 patients have no OPD visit on record.** Of these, 1,332 have no visit of any kind, and 2 have only a LAB visit.
- OPD history spans **2021-12-31 → 2026-08-13**. The four 2021 visits are all on 31 Dec 2021.
- Do not use `patients.created_at` for year-wise counts: 84% of rows (14,959) were inserted during the Feb–Mar 2026 bulk import, which reflects when data was loaded, not when patients were seen.
- 2024 is a genuine dip in both new and active patients, not a partial year.

## Source

```sql
-- every figure above comes from:
SELECT ... FROM consultations WHERE visit_type = 'OPD'
```

Regenerate the underlying per-patient data with:

```bash
node server/scripts/export-all-patients.js   # full per-patient CSV, all-time
node server/scripts/count-all-patients.js    # totals and breakdowns
```
