const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";

export async function gotoReady(page, url, ready, { attempts = 3, timeout = 10000 } = {}) {
  let networkChanged = false;
  const watch = (request) => {
    if (request.failure()?.errorText === NETWORK_CHANGED) networkChanged = true;
  };
  page.on("requestfailed", watch);
  try {
    for (let attempt = 1; ; attempt += 1) {
      networkChanged = false;
      try {
        await page.goto(url);
        await ready().waitFor({ state: "visible", timeout });
        return;
      } catch (error) {
        const glitch = networkChanged || String(error?.message).includes(NETWORK_CHANGED);
        if (!glitch || attempt >= attempts) throw error;
      }
    }
  } finally {
    page.off("requestfailed", watch);
  }
}
