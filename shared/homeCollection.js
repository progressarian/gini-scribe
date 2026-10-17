export const HOME_SITE_LABEL = { home: "🏠 Home", ghm: "🏥 GHM" };

export const istClock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : "";

export const homeSampleText = (sample) =>
  sample?.site
    ? [HOME_SITE_LABEL[sample.site] || sample.site, sample.by, istClock(sample.at)]
        .filter(Boolean)
        .join(" · ")
    : "🏠 Home collection";
