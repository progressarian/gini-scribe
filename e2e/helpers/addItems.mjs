export async function openAddItems(page) {
  const box = page.getByRole("region", { name: "Add items" });
  const toggle = box.getByRole("button", { name: "Add items" });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await box.getByRole("searchbox", { name: "Search items" }).waitFor();
}
