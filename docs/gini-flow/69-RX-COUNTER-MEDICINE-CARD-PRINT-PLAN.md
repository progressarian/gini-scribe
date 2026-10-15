# 69 — Print the medicine card at the Prescription Explain counter

Status: **built 15 Oct 2026** (not committed).

## 1. What and why

At the Prescription Explain counter the patient should leave with **two sheets**: the
prescription, and a **medicine card**. The card lists their medicines grouped by when to take
them, in the same style as the MyHealthGenie app's Care plan → Medicines tab: After Breakfast,
After Dinner, and so on.

The counter already shows this card on screen (`RxStationPage.jsx`, "Medicine card" section,
built from `data.card`). What's missing is a way to **print** it.

## 2. Decisions (15 Oct 2026)

1. A medicine taken at several times (e.g. BD) is printed **under each time**, as the app does.
2. **English only.**
3. **A4**, the same printer and paper as the prescription.

## 3. What exists and what is reused

| Piece                                                            | File                                                                                                 | Reuse                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Card data (active medicines, timings, prescriber, Gini/external) | `server/services/giniflow/medicineCard.js` `buildCard()`                                             | Data source, unchanged for screens                                 |
| Card PDF (plain two-column table today)                          | `server/services/giniflow/medicineCardPdf.js`                                                        | **Restyled** to the app look and given the prescription letterhead |
| PDF renderer (shared puppeteer)                                  | `server/services/prescriptionHtmlPdf.js` `renderHtmlToPdf`                                           | As is                                                              |
| Letterhead and logo                                              | `server/templates/prescriptionTemplate.js` `letterheadHtml`, `LETTERHEAD_CSS`; `getPrescriptionLogo` | As is                                                              |
| Slot vocabulary                                                  | `shared/giniflowMedTiming.js` `MED_SLOTS`, `SLOT_ORDER`                                              | As is                                                              |
| Print button pattern (fetch PDF blob, open viewer)               | `src/pages/giniflow/consult/MedCardSection.jsx`; `PdfViewerModal`                                    | As is                                                              |

The doctor's consult screen prints through the same PDF function, so its printed card gets the
new look too. That keeps one card everywhere.

## 4. The printed card (A4)

```
┌──────────────────────────────────────────────┐
│ [Hospital letterhead + logo — as prescription]│
│ Medicine card                     15 Oct 2026 │
│ Kuldeep Singh · P_182211 · 58M                │
│ Dr Anil Bhansali                              │
├──────────────────────────────────────────────┤
│ ☕  After Breakfast                        (2) │
│   ┌────────────────────────────────────────┐ │
│   │ Glycomet GP 2   1 tab · Oral            │ │
│   │ Metformin + Glimepiride · for Diabetes  │ │
│   │ ⓘ Take after food                       │ │
│   └────────────────────────────────────────┘ │
│   ┌────────────────────────────────────────┐ │
│   │ ...                                      │ │
│ 🌆  After Dinner                           (1) │
│   ...                                          │
│ ⏰  Timing not set                          (1) │  ← only if any
├──────────────────────────────────────────────┤
│ Not from Gini: <external medicines, marked>   │
│ Footer: hospital address / phone (as Rx)      │
└──────────────────────────────────────────────┘
```

**Style, taken from the app** (`GiniCareV9.tsx`, `MedCardV9.tsx`, `v9Theme.ts`):

- **Time heading row:**
  - 32×32 icon tile, radius 10, background `#ede9fe`
  - label 13–14pt, weight 800
  - count pill in `#7c5cff` with white text
  - row background `#f5f3ff` with border `#ddd6fe`
  - always expanded on paper
- **Medicine card:**
  - white, radius 14, 1px border `#e5e7eb`
  - name in bold, then dose · route · frequency
  - composition and "for <diagnosis>" in grey
  - an instruction line when present
  - tags: "New", "Dose changed" (from `changeType`) and "Not from Gini" (external)
- **Icons:** the app's emoji-to-icon mapping, drawn as inline SVG from lucide so they print
  sharply in black and white too: ☕ Coffee, 🌆 Sunset, 🌅 Sunrise, 🌙 Moon, 🍽 Utensils,
  🕒 Clock, 📅 Calendar.
- **Order** follows `SLOT_ORDER`: Fasting → Before/After Breakfast → Lunch → Evening → Dinner →
  Bedtime → With meals → Any time → Weekly → Fortnightly → SOS → Timing not set.
- **Long content:** long names and compositions wrap, and no card is split across pages
  (`break-inside: avoid`). Page numbers go in the footer when it runs past one page.
- **Missing values:** a medicine with no dose prints "—", never "undefined". A patient with no
  active medicines prints "No active medicines".

## 5. Server

- New **`groupForPrint(card)`** in `medicineCardPdf.js` repeats each medicine under every slot it
  belongs to. The slots come from `whenToTake`/`timing`, using the same rules as
  `shared/giniflowMedTiming.js`, falling back to the existing single group. Screens keep using
  `buildCard()` unchanged.
- `buildMedicineCardHtml(card, patient, doctor, logo)` is rewritten with the style above and the
  prescription letterhead.
- New route **`GET /api/giniflow/stations/rx/:visitId/medicine-card.pdf`**:
  - gated by the Rx counter's existing print capability (`GINIFLOW_PRINT_RX`), with the
    capability added on both server and client per `shared/permissions.js` rules;
  - streams `application/pdf` with `Cache-Control: no-store`;
  - returns 404 "Visit not found" for an unknown visit;
  - errors never show internal details.
- The doctor route keeps working and returns the new look.

## 6. Screen (Rx counter, `RxStationPage.jsx`)

- A **"🖨 Print medicine card"** button sits beside "View / print prescription" in the patient
  pane. It is a secondary style, so the prescription stays the primary action.
- Clicking it opens the PDF in the existing `PdfViewerModal`, which has the browser's Print
  button. The button shows "Preparing…" while loading. On failure the pane shows "Couldn't
  prepare the medicine card — try again".
- The button is disabled, with the hint "No medicines on the card", when the card is empty.
- Optional: a confirmation line "Medicine card printed" is noted on the visit's timeline (marker
  `med_card_printed`). Whether to keep this is open question 1.

## 7. Tests (Playwright, test DB)

`e2e/giniflow/G93-rx-counter-medicine-card.spec.js`:

1. **Grouping:** a BD medicine appears under After Breakfast **and** After Dinner; a
   once-daily one under its own time; an unset timing under "Timing not set". Slots are in
   `SLOT_ORDER`.
2. **HTML content:** the patient name, UHID, doctor, letterhead, count pills matching the
   medicines, "Not from Gini" for external medicines, and no "undefined" or "null" anywhere.
3. **Route:** the Rx counter role gets a `200 application/pdf` starting with `%PDF`; a role
   without the capability gets 403; an unknown visit gets 404.
4. **Screen:** on the Rx counter, "Print medicine card" opens the viewer with the PDF; with no
   medicines it is disabled and shows the hint.
5. **Doctor print:** the existing doctor medicine-card route still returns a PDF (regression).
6. **Long data:** 25 medicines with long names render on several pages without a split card
   (checked via the page count and `break-inside` in the HTML).

## 7a. Build order

1. `groupForPrint` and the new HTML, with tests 1, 2 and 6.
2. The rx route and permission, with tests 3 and 5.
3. The button and viewer, with test 4.
4. `npm run build`, `check:giniflow`, Prettier, then the Gini Flow suite.

## 8. Decided

1. Printing the card is **not** recorded on the visit timeline.
2. The card shows the **next visit date** when the appointment has a follow-up later than the
   visit (`ownFu`, the same source the GHM sheet uses).
3. The route is `GET /api/giniflow/stations/rx/:visitId/medicine-card.pdf`, gated by
   `GINIFLOW_PRINT_RX`. It opens in the counter's existing PDF viewer. The doctor's printed
   card uses the same new layout.
