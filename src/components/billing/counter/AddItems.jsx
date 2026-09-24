import { useEffect, useMemo, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useAddBillLine,
  useItemSearch,
  useMyRequests,
  useNewItemRequest,
  useRepeatRequest,
} from "../../../queries/hooks/useBilling";
import { errorOf } from "../format";
import { requestKindText, requestStatusText } from "./lineText";

export default function AddItems({ bill, onBill }) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [asking, setAsking] = useState(null);
  const [reason, setReason] = useState("");
  const [wantsNew, setWantsNew] = useState(false);
  const [proposed, setProposed] = useState({ name: "", group: "", reason: "" });
  const [blocked, setBlocked] = useState({});

  const { data, isFetching } = useItemSearch(debounced);
  const { data: requests } = useMyRequests(bill.visit_id);
  const addLine = useAddBillLine();
  const repeat = useRepeatRequest();
  const newItem = useNewItemRequest();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const billed = useMemo(() => {
    const seen = { ...blocked };
    for (const line of bill.lines) seen[line.service_item_id] = seen[line.service_item_id] ?? {};
    return seen;
  }, [bill.lines, blocked]);

  const items = data?.items || [];
  const mine = (requests || []).filter(
    (request) => !request.visit_id || request.visit_id === bill.visit_id,
  );

  const add = async (itemId, repeatRequestId) => {
    setError(null);
    setNote(null);
    try {
      onBill(
        await addLine.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          item_id: itemId,
          ...(repeatRequestId ? { repeat_request_id: repeatRequestId } : {}),
        }),
      );
    } catch (e) {
      const detail = e?.response?.data || {};
      if (detail.service_item_id) {
        setBlocked((was) => ({
          ...was,
          [detail.service_item_id]: { bill_no: detail.bill_no, bill_id: detail.bill_id },
        }));
      }
      setError(errorOf(e, "That item could not be added"));
    }
  };

  const askRepeat = async () => {
    setError(null);
    try {
      await repeat.mutateAsync({
        service_item_id: asking.id,
        visit_id: bill.visit_id,
        bill_id: bill.id,
        reason: reason.trim(),
      });
      setAsking(null);
      setReason("");
      setNote(`Asked an admin to bill ${asking.name} again.`);
    } catch (e) {
      setError(errorOf(e, "That request could not be sent"));
    }
  };

  const askNewItem = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await newItem.mutateAsync({
        proposed_name: proposed.name.trim(),
        ...(proposed.group.trim() ? { proposed_group: proposed.group.trim() } : {}),
        reason: proposed.reason.trim(),
        visit_id: bill.visit_id,
        bill_id: bill.id,
      });
      setWantsNew(false);
      setProposed({ name: "", group: "", reason: "" });
      setNote("Asked an admin to create that item.");
    } catch (e) {
      setError(errorOf(e, "That request could not be sent"));
    }
  };

  const openNewItem = () => {
    setError(null);
    setNote(null);
    setProposed({ name: search.trim(), group: "", reason: "" });
    setWantsNew(true);
  };

  if (bill.status !== "draft") return null;

  return (
    <section className="bc-card" aria-label="Add items">
      <h3 className="bc-card__title">Add items</h3>
      <label className="bc-field">
        <span className="bc-field__lbl">Search items</span>
        <input
          className="bc-field__in"
          type="search"
          value={search}
          placeholder="Name or code…"
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>

      {debounced && !isFetching && !items.length && (
        <div className="bc-empty-search">
          <span>No item matches “{debounced}”.</span>
          <button type="button" className="st-btn st-btn-g" onClick={openNewItem}>
            Request new item
          </button>
        </div>
      )}

      {!!items.length && (
        <ul className="bc-results" aria-label="Item search results">
          {items.map((item) => {
            const stop = billed[item.id];
            return (
              <li key={item.id} className={`bc-result${stop ? " bc-result--billed" : ""}`}>
                <span className="bc-result__name">{item.name}</span>
                <span className="bc-result__meta">
                  {item.code} · {item.group_name} › {item.subgroup_name}
                </span>
                {stop ? (
                  <button
                    type="button"
                    className="st-btn st-btn-g"
                    onClick={() => {
                      setReason("");
                      setError(null);
                      setAsking(item);
                    }}
                  >
                    Ask admin to bill again
                  </button>
                ) : (
                  <button
                    type="button"
                    className="st-btn st-btn-grn"
                    disabled={addLine.isPending}
                    onClick={() => add(item.id)}
                  >
                    Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {wantsNew && (
        <form className="bc-newitem" onSubmit={askNewItem} aria-label="Request a new item">
          <label className="bc-field">
            <span className="bc-field__lbl">Item name</span>
            <input
              className="bc-field__in"
              value={proposed.name}
              onChange={(e) => setProposed({ ...proposed, name: e.target.value })}
            />
          </label>
          <label className="bc-field">
            <span className="bc-field__lbl">Group</span>
            <input
              className="bc-field__in"
              value={proposed.group}
              onChange={(e) => setProposed({ ...proposed, group: e.target.value })}
            />
          </label>
          <label className="bc-field">
            <span className="bc-field__lbl">Why is it needed?</span>
            <input
              className="bc-field__in"
              value={proposed.reason}
              onChange={(e) => setProposed({ ...proposed, reason: e.target.value })}
            />
          </label>
          <button
            type="submit"
            className="st-btn st-btn-grn"
            disabled={!proposed.name.trim() || !proposed.reason.trim() || newItem.isPending}
          >
            Send request
          </button>
          <button type="button" className="st-btn st-btn-g" onClick={() => setWantsNew(false)}>
            Cancel
          </button>
        </form>
      )}

      {note && <div className="bc-note">{note}</div>}
      {error && <div className="bc-err">{error}</div>}

      <section className="bc-requests" aria-label="My requests">
        <h4 className="bc-card__title">My requests</h4>
        {!mine.length ? (
          <div className="empty-note">Nothing asked for yet.</div>
        ) : (
          <ul className="bc-results">
            {mine.map((request) => {
              const item = request.created_item || request.item;
              const canAdd =
                request.kind === "repeat_item"
                  ? request.usable && !!request.item
                  : request.status === "approved" && !!request.created_item;
              return (
                <li key={request.id} className="bc-result">
                  <span className="bc-result__name">{item?.name || request.proposed_name}</span>
                  <span className="bc-result__meta">
                    {requestKindText(request.kind)} · {requestStatusText(request.status)}
                    {request.decision_note ? ` · ${request.decision_note}` : ""}
                  </span>
                  {canAdd && (
                    <button
                      type="button"
                      className="st-btn st-btn-grn"
                      disabled={addLine.isPending}
                      onClick={() =>
                        add(item.id, request.kind === "repeat_item" ? request.id : null)
                      }
                    >
                      Add to bill
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmModal
        open={!!asking}
        variant="primary"
        title={asking ? `Ask admin to bill ${asking.name} again?` : ""}
        confirmLabel="Send request"
        busy={repeat.isPending}
        error={error}
        confirmDisabled={!reason.trim()}
        message={
          <label className="bc-field">
            <span className="bc-field__lbl">Why must it be billed again?</span>
            <textarea
              className="bc-field__in"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        }
        onConfirm={askRepeat}
        onCancel={() => setAsking(null)}
      />
    </section>
  );
}
