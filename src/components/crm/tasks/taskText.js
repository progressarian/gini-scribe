const shortDate = (day) =>
  new Date(`${day}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export function dueText(task) {
  if (!task.due_date) return "No due date";
  const late = Number(task.days_overdue);
  if (late > 0)
    return `${late} day${late === 1 ? "" : "s"} overdue · since ${shortDate(task.due_date)}`;
  if (late === 0) return "Due today";
  return `Due ${shortDate(task.due_date)}`;
}

export const isOpen = (task) => task.status === "open" || task.status === "in_progress";
