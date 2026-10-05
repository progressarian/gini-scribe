import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  ITEM_SEARCH_LIMIT,
  ITEM_SEARCH_MIN,
  useAddBillLine,
  useItemSearch,
  useMyRequests,
  useNewItemRequest,
  useRepeatRequest,
} from "../../../queries/hooks/useBilling";
import { errorOf, moneyTyped, rupees } from "../format";
import { requestKindText, requestStatusText } from "./lineText";

const BLANK_PROPOSAL = { name: "", group: "", reason: "" };

export const ITEM_SEARCH_ID = "bc-item-search";

export default function AddItems({ bill, onBill, form }) {
  const search = form.value.search;
  const setSearch = (next) => form.set("search", next);
  const [debounced, setDebounced] = useState("");
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const again = form.value.again;
  const asking = again?.item ?? null;
  const reason = again?.reason ?? "";
  const setReason = (next) => form.set("again", (was) => was && { ...was, reason: next });
  const wantsNew = form.value.newItem !== null;
  const proposed = form.value.newItem ?? BLANK_PROPOSAL;
  const setProposed = (next) => form.set("newItem", next);
  const [blocked, setBlocked] = useState({});
  const [prices, setPrices] = useState({});
  const inputRef = useRef(null);
  const focusing = useRef(false);
  const open = Boolean(form.value.addOpen || search || again || wantsNew);

  const { data, isFetching } = useItemSearch(debounced, bill.visit_id, bill.category, {
    enabled: open,
  });

  useEffect(() => {
    if (open && focusing.current) {
      focusing.current = false;
      inputRef.current?.focus();
    }
  }, [open]);

  const toggle = () => {
    if (open) {
      form.set("addOpen", false);
      if (search) setSearch("");
      return;
    }
    focusing.current = true;
    form.set("addOpen", true);
  };
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

  const searching = debounced.length >= ITEM_SEARCH_MIN;
  const browsing = !search.trim() && !debounced;
  const items = searching
    ? data?.items || []
    : browsing
      ? (data?.items || []).filter((item) => item.uses > 0)
      : [];
  const settling = search.trim() !== debounced || isFetching;
  const noMatch = searching && !!data && !isFetching && !items.length;
  const { data: popularData } = useItemSearch("", bill.visit_id, bill.category, {
    enabled: open && noMatch,
  });
  const popular = noMatch ? (popularData?.items || []).filter((item) => item.uses > 0) : [];
  const listed = items.length ? items : popular;
  const consultationType = searching ? data?.consultation_type : null;
  const showsConsultations =
    !!consultationType &&
    (data.consultations_hidden || items.some((item) => item.kind === "consultation"));
  const mine = (requests || []).filter(
    (request) => !request.visit_id || request.visit_id === bill.visit_id,
  );

  const add = async (itemId, repeatRequestId, agreedRate) => {
    setError(null);
    setNote(null);
    try {
      onBill(
        await addLine.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          item_id: itemId,
          ...(repeatRequestId ? { repeat_request_id: repeatRequestId } : {}),
          ...(agreedRate ? { agreed_rate: agreedRate } : {}),
        }),
      );
      setPrices((was) => ({ ...was, [itemId]: "" }));
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
      form.drop("again");
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
      form.drop("newItem");
      setNote("Asked an admin to create that item.");
    } catch (e) {
      setError(errorOf(e, "That request could not be sent"));
    }
  };

  const openNewItem = () => {
    setError(null);
    setNote(null);
    setProposed({ ...BLANK_PROPOSAL, name: search.trim() });
  };

  if (bill.status !== "draft") return null;

  return (
    <section className="bc-card bc-additems" aria-label="Add items">
      <h3 className="bc-card__title">
        <button
          type="button"
          className="bc-additems__toggle"
          aria-expanded={open}
          aria-controls="bc-additems-body"
          onClick={toggle}
        >
          Add items
          {open ? (
            <ChevronUp size={16} aria-hidden="true" />
          ) : (
            <ChevronDown size={16} aria-hidden="true" />
          )}
        </button>
      </h3>
      {open && (
        <div id="bc-additems-body" className="bc-additems__body">
          <label className="bc-field">
            <span className="bc-field__lbl">Search items</span>
            <input
              id={ITEM_SEARCH_ID}
              ref={inputRef}
              className="bc-field__in"
              type="search"
              value={search}
              placeholder="Search by name or code — use commas for several: cbc, hba1c"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          {search.trim().length > 0 && search.trim().length < ITEM_SEARCH_MIN && (
            <div className="bc-hint bc-search-hint" role="status">
              Type at least {ITEM_SEARCH_MIN} letters of a service name or code
            </div>
          )}

          {browsing && isFetching && !items.length && (
            <div className="bc-hint bc-search-hint" role="status">
              Loading the most used items…
            </div>
          )}

          {browsing && !!items.length && (
            <div className="bc-hint bc-search-hint" role="status">
              Most used in the last 90 days — type to search everything
            </div>
          )}

          {searching && data && !isFetching && !items.length && (
            <div className="bc-empty-search">
              <span>No item matches “{debounced}”.</span>
              <button type="button" className="st-btn st-btn-g" onClick={openNewItem}>
                Request new item
              </button>
            </div>
          )}

          {showsConsultations && (
            <div className="bc-hint bc-search-hint" role="status">
              Showing {consultationType} consultations for this visit
            </div>
          )}

          {noMatch && !!popular.length && (
            <div className="bc-hint bc-search-hint" role="status">
              Most used in the last 90 days
            </div>
          )}

          {!!listed.length && (
            <ul className="bc-results bc-results--scroll" aria-label="Item search results">
              {listed.map((item) => {
                const stop = billed[item.id];
                const needsPrice = item.price_per_patient || !item.rate;
                return (
                  <li key={item.id} className={`bc-result${stop ? " bc-result--billed" : ""}`}>
                    <span className="bc-result__name" title={item.name}>
                      {item.name}
                    </span>
                    <span
                      className="bc-result__meta"
                      title={`${item.code} · ${item.group_name} › ${item.subgroup_name}`}
                    >
                      {item.code} · {item.group_name} › {item.subgroup_name}
                      {item.uses > 0 && ` · billed ${item.uses}× in 90 days`}
                    </span>
                    {!needsPrice && (
                      <span
                        className="bc-result__rate"
                        title={
                          item.rate_source === "base" ? "List price" : "Rate for this category"
                        }
                      >
                        {rupees(item.rate)}
                      </span>
                    )}
                    {stop ? (
                      <button
                        type="button"
                        className="st-btn st-btn-g"
                        disabled={settling}
                        onClick={() => {
                          setError(null);
                          form.set("again", { item: { id: item.id, name: item.name }, reason: "" });
                        }}
                      >
                        Ask admin to bill again
                      </button>
                    ) : (
                      <>
                        {needsPrice && (
                          <input
                            className="bc-field__in bc-result__price"
                            inputMode="decimal"
                            placeholder="₹ price"
                            title={
                              item.price_per_patient
                                ? "Priced for each patient"
                                : "No price set — enter this patient's price"
                            }
                            aria-label={`${item.name}: price for this patient`}
                            value={prices[item.id] ?? ""}
                            onChange={(e) =>
                              setPrices((was) => ({
                                ...was,
                                [item.id]: moneyTyped(e.target.value),
                              }))
                            }
                          />
                        )}
                        <button
                          type="button"
                          className="st-btn st-btn-grn"
                          disabled={addLine.isPending || settling}
                          onClick={() => add(item.id, undefined, prices[item.id]?.trim())}
                        >
                          Add
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {searching && !!items.length && data?.more && (
            <div className="bc-hint bc-search-hint" role="status">
              Showing first {ITEM_SEARCH_LIMIT} — keep typing to narrow
            </div>
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
              <button
                type="button"
                className="st-btn st-btn-g"
                onClick={() => form.drop("newItem")}
              >
                Cancel
              </button>
            </form>
          )}

          {note && <div className="bc-note">{note}</div>}
          {error && <div className="bc-err">{error}</div>}
        </div>
      )}

      {(open || mine.length > 0) && (
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
      )}

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
        onCancel={() => form.drop("again")}
      />
    </section>
  );
}
