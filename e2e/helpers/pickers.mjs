const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const pageOf = (scope) => (typeof scope.page === "function" ? scope.page() : scope);

export const fieldName = (label) =>
  label instanceof RegExp ? label : new RegExp(`^${escape(label)}(\\s|$)`);

export async function pickOption(scope, label, option) {
  await scope.getByRole("button", { name: fieldName(label) }).click();
  await pageOf(scope)
    .locator("[data-popover-layer]")
    .last()
    .getByRole("option", { name: option, exact: typeof option === "string" })
    .click();
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export async function pickDate(scope, label, iso) {
  const page = pageOf(scope);
  await scope.getByRole("button", { name: fieldName(label) }).click();
  const layer = page.locator("[data-popover-layer]").last();
  const [year, month] = iso.split("-").map(Number);
  for (let step = 0; step < 80; step += 1) {
    const heading = await layer
      .getByText(new RegExp(`^(${MONTHS.join("|")}) \\d{4}$`))
      .textContent();
    const [name, shownYear] = heading.trim().split(" ");
    const diff = (year - Number(shownYear)) * 12 + (month - 1 - MONTHS.indexOf(name));
    if (diff === 0) break;
    const button =
      diff >= 12
        ? "Next year"
        : diff <= -12
          ? "Previous year"
          : diff > 0
            ? "Next month"
            : "Previous month";
    await layer.getByRole("button", { name: button, exact: true }).click();
  }
  await layer.getByRole("button", { name: String(Number(iso.slice(8, 10))), exact: true }).click();
}
