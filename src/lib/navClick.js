// Build a click handler that opens the path in a new tab when the user
// holds ctrl / cmd / shift, or uses middle-click. Otherwise it navigates
// in-app via react-router's navigate.
export const makeNavClick = (navigate) => (path, opts) => (e) => {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) {
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    const url = typeof path === "string" ? path : String(path);
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  navigate(path, opts);
};
