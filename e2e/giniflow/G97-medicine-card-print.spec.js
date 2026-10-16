import { test, expect } from "@playwright/test";

const { buildMedicineCardHtml, groupForPrint } =
  await import("../../server/services/giniflow/medicineCardPdf.js");

const card = {
  groups: [
    {
      medicines: [
        {
          medicationId: 1,
          name: "Empabite M",
          dose: "12.5/1 g",
          route: "Oral",
          frequency: "OD",
          whenToTake: ["Before breakfast"],
        },
        {
          medicationId: 2,
          name: "Telma",
          dose: "40 mg",
          route: "Oral",
          frequency: "OD",
          whenToTake: ["At bedtime"],
        },
        {
          medicationId: 3,
          name: "Semalix XL",
          dose: "0.25 mg",
          route: "SC",
          frequency: "Once weekly · Fri",
          whenToTake: ["At bedtime"],
        },
        {
          medicationId: 4,
          name: "IMPD3",
          dose: "60,000 units",
          route: "SC",
          frequency: "Once weekly · Fri",
          whenToTake: ["Any time"],
          instruction: "for 4 weeks",
        },
        {
          medicationId: 5,
          name: "Biweekly",
          dose: "1 inj",
          frequency: "Once fortnightly",
          whenToTake: ["After breakfast"],
        },
        {
          medicationId: 6,
          name: "Taper",
          dose: "1 tab",
          frequency: "BD for 10 days, then OD for 6 weeks",
          whenToTake: ["After dinner"],
        },
      ],
    },
  ],
};

const html = () =>
  buildMedicineCardHtml({
    patient: { name: "Card Patient", file_no: "P_CARD", age: 60, sex: "F" },
    card,
    printedAt: "16 Oct 2026",
    doctorName: "Dr Card",
  });

test.describe("G97 the printed medicine card", () => {
  test("1. once-weekly and fortnightly medicines group by their repeat, not a time of day", () => {
    const groups = Object.fromEntries(
      groupForPrint(card).map((g) => [g.label, g.medicines.map((m) => m.name)]),
    );
    expect(groups["Bedtime"]).toEqual(["Telma"]);
    expect(groups["Weekly"]).toEqual(["Semalix XL", "IMPD3"]);
    expect(groups["Once in 14 days"]).toEqual(["Biweekly"]);
    expect(groups["After Dinner"]).toEqual(["Taper"]);
    expect(html()).toContain("0.25 mg · SC · Once weekly · Fri · Bedtime");
    expect(html()).toContain("60,000 units · SC · Once weekly · Fri<");
  });

  test("2. the card loads the letterhead fonts and prints no unsupported symbols", () => {
    const out = html();
    expect(out).toContain("fonts.googleapis.com/css2?family=Instrument+Serif");
    expect(out).toContain("family=Outfit");
    expect(out).not.toContain("ⓘ");
    expect(out).toMatch(/mc-inst"><svg[^>]*>.*<\/svg><span>for 4 weeks<\/span>/);
  });

  test("3. the letterhead and patient line repeat on every page", () => {
    const out = html();
    const thead = out.slice(out.indexOf("<thead>"), out.indexOf("</thead>"));
    expect(thead).toContain('class="rx-header"');
    expect(thead).toContain("<b>Card Patient</b> · P_CARD · 60F");
    expect(thead).toContain("Medicine card");
    expect(out.indexOf("Empabite M")).toBeGreaterThan(out.indexOf("</thead>"));
  });

  test("4. the card closes with the same footer strip as the prescription", () => {
    const footer = {
      serviceLines: ["Online consultation available"],
      appLine: "Track this prescription on My Gini app",
      storeLine: "Available on Play store and App Store",
    };
    const out = buildMedicineCardHtml({
      patient: { name: "Card Patient", file_no: "P_CARD" },
      card,
      printedAt: "16 Oct 2026",
      footer,
    });
    expect(out).toContain('<div class="mc-close"><div class="rx-promo">');
    expect(out).toContain("Online consultation available");
    expect(out).toContain("Track this prescription on My Gini app");
    expect(out.indexOf('<div class="mc-close">')).toBeGreaterThan(out.lastIndexOf("Biweekly"));
    expect(html()).not.toContain('mc-close"><div');
  });
});
