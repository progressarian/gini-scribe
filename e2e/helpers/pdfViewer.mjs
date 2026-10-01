import { expect } from "@playwright/test";

export const pdfViewer = (page) => page.locator(".pdf-modal");

export async function expectPdfInViewer(page, path, title) {
  const viewer = pdfViewer(page);
  await expect(viewer).toBeVisible();
  if (title) await expect(viewer.locator(".pdf-modal-name")).toHaveText(title);
  const download = viewer.getByTitle("Download");
  await expect(download).toHaveAttribute("href", new RegExp(path.replace(/[.?]/g, "\\$&")));
  await expect(viewer.locator("canvas.pdf-js-page").first()).toBeVisible();
  await expect(viewer.locator(".pdf-js-overlay")).toHaveCount(0);
  return download.getAttribute("href");
}

export async function closePdfViewer(page) {
  await pdfViewer(page).locator(".pdf-btn-close").click();
  await expect(pdfViewer(page)).toHaveCount(0);
}
