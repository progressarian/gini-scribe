import { Link } from "react-router-dom";
import { taskKindLabel, taskPriorityMeta } from "../../../../shared/crmVocab.js";
import { dueText, isOpen } from "./taskText.js";

export default function TaskRow({ task, actions, showOwner }) {
  const pri = taskPriorityMeta(task.priority);
  const open = isOpen(task);
  const assignedBy =
    task.created_by_name && task.created_by !== task.owner_id ? task.created_by_name : null;

  return (
    <li className={`rep__row tsk__row ${task.overdue && open ? "tsk__row--late" : ""}`}>
      <div className="rep__row-main">
        <strong className="tsk__title">{task.title}</strong>
        <span className="rep__row-sub">
          {task.doctor_id ? (
            <Link to={`/crm/doctor/${task.doctor_id}`} className="rep__link">
              {task.doctor_name}
            </Link>
          ) : (
            "No doctor"
          )}
          {task.doctor_area ? ` · ${task.doctor_area}` : ""}
          {showOwner && task.owner_name ? ` · ${task.owner_name}` : ""}
        </span>
        <span className="rep__row-flags">
          <span className={`rep__due ${open && task.overdue ? "rep__due--red" : "rep__due--ink"}`}>
            {open
              ? dueText(task)
              : task.status === "done"
                ? "Done"
                : `Cancelled${task.cancel_reason ? `: ${task.cancel_reason}` : ""}`}
          </span>
          <span className="rep__flag">{taskKindLabel(task.kind)}</span>
          {pri && task.priority !== "normal" && (
            <span className={`rep__due rep__due--${pri.tone}`}>{pri.label} priority</span>
          )}
          {assignedBy && <span className="rep__flag">From {assignedBy}</span>}
        </span>
      </div>
      <div className="rep__row-actions tsk__actions">
        {open && task.kind === "follow_up_visit" && task.doctor_id && (
          <Link
            className="rep__btn rep__btn--primary rep__btn--sm"
            to={`/crm/visit/${task.doctor_id}?name=${encodeURIComponent(task.doctor_name || "")}`}
          >
            Log visit
          </Link>
        )}
        {open && task.kind !== "follow_up_visit" && (
          <button
            type="button"
            className="rep__btn rep__btn--primary rep__btn--sm"
            disabled={actions.busy === task.id}
            onClick={() => actions.done(task)}
          >
            Done
          </button>
        )}
        {open && (
          <button
            type="button"
            className="rep__btn rep__btn--sm"
            disabled={actions.busy === task.id}
            onClick={() => actions.askCancel(task)}
          >
            Cancel
          </button>
        )}
        {!open && task.can_reopen && (
          <button
            type="button"
            className="rep__btn rep__btn--sm"
            disabled={actions.busy === task.id}
            onClick={() => actions.reopen(task)}
          >
            Reopen
          </button>
        )}
      </div>
    </li>
  );
}
