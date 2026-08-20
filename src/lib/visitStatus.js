const MAP = {
  seen: { key: "seen", label: "Seen", tone: "green" },
  completed: { key: "seen", label: "Seen", tone: "green" },
  in_visit: { key: "in_visit", label: "In Visit", tone: "purple" },
  checkedin: { key: "checkedin", label: "Checked In", tone: "sky" },
  prepped: { key: "prepped", label: "Ready", tone: "teal" },
  no_show: { key: "no_show", label: "No Show", tone: "gray" },
};

export function visitStatus(status) {
  return (
    MAP[String(status || "").toLowerCase()] || { key: "pending", label: "Pending", tone: "gray" }
  );
}
