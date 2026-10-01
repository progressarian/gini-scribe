import { useEffect, useState } from "react";
import {
  useAddOrderedService,
  useOrderedServiceChoices,
  useOrderedServices,
  useRemoveOrderedService,
} from "../../queries/hooks/useOrderedServices";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";
import { errorOf, fromPaise, moneyTyped } from "./format";
import "./orderedServices.css";

const SEARCH_MIN = 2;

function ServiceRow({ service, mayRemove, onRemove, busy }) {
  const [reason, setReason] = useState(null);
  return (
    <li className="osv-row">
      <div className="osv-row__main">
        <span className="osv-row__name">{service.name}</span>
        <span className="osv-row__price">{fromPaise(service.patient_payable)}</span>
      </div>
      <div className="osv-row__meta">
        {service.added_by_name ? `Added by ${service.added_by_name}` : "Added"}
        {service.price_set_by_name && service.price_set_by_name !== service.added_by_name
          ? ` · price by ${service.price_set_by_name}`
          : ""}
        {service.bill_status === "final" ? ` · billed ${service.bill_no ?? ""}` : ""}
      </div>
      {mayRemove && service.bill_status === "draft" && reason === null && (
        <button type="button" className="osv-btn osv-btn--ghost" onClick={() => setReason("")}>
          Remove
        </button>
      )}
      {reason !== null && (
        <div className="osv-remove">
          <input
            className="osv-input"
            placeholder="Why is it being removed?"
            aria-label={`Why ${service.name} is being removed`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="osv-btn osv-btn--danger"
            disabled={busy || !reason.trim()}
            onClick={() => onRemove(service, reason.trim())}
          >
            Remove
          </button>
          <button type="button" className="osv-btn osv-btn--ghost" onClick={() => setReason(null)}>
            Keep
          </button>
        </div>
      )}
    </li>
  );
}

export default function OrderedServicesPanel({ station, visitId, readOnly = false, onToast }) {
  const me = useAuthStore((st) => st.currentDoctor);
  const admin = hasCapability(me?.role, CAPABILITIES.ADMIN);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [chosen, setChosen] = useState(null);
  const [price, setPrice] = useState("");
  const [error, setError] = useState(null);
  const { data } = useOrderedServices(station, visitId);
  const searching = debounced.length >= SEARCH_MIN;
  const { data: choices = [], isFetching } = useOrderedServiceChoices(
    station,
    visitId,
    searching ? debounced : "",
  );
  const add = useAddOrderedService(station, visitId);
  const remove = useRemoveOrderedService(station, visitId);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const services = data?.services ?? [];
  const priceNeeded = chosen?.price_needed ?? true;

  const confirm = async () => {
    setError(null);
    try {
      await add.mutateAsync({
        item_id: chosen.item_id,
        ...(price.trim() ? { agreed_rate: price.trim() } : {}),
      });
      onToast?.(`${chosen.name} added for this patient`);
      setChosen(null);
      setPrice("");
      setSearch("");
    } catch (e) {
      if (e?.response?.data?.code === "price_needed") setChosen({ ...chosen, price_needed: true });
      setError(errorOf(e, "That service could not be added"));
    }
  };

  const drop = async (service, reason) => {
    setError(null);
    try {
      await remove.mutateAsync({ lineId: service.line_id, reason });
      onToast?.(`${service.name} removed`);
    } catch (e) {
      setError(errorOf(e, "That service could not be removed"));
    }
  };

  return (
    <div className="osv">
      {services.length ? (
        <ul className="osv-list" aria-label="Services ordered for this patient">
          {services.map((service) => (
            <ServiceRow
              key={service.line_id}
              service={service}
              busy={remove.isPending}
              mayRemove={!readOnly && (service.added_by === me?.id || admin)}
              onRemove={drop}
            />
          ))}
        </ul>
      ) : (
        <div className="osv-empty">No procedures ordered for this patient.</div>
      )}

      {!readOnly && !chosen && (
        <div className="osv-add">
          <input
            className="osv-input"
            type="search"
            placeholder="Add a procedure — type 2 letters…"
            aria-label="Search procedures priced per patient"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {searching && !isFetching && !choices.length && (
            <div className="osv-empty">No procedure matches “{debounced}”.</div>
          )}
          {searching && !!choices.length && (
            <ul className="osv-choices" aria-label="Procedures">
              {choices.map((choice) => (
                <li key={choice.item_id}>
                  <button
                    type="button"
                    className="osv-choice"
                    onClick={() => {
                      setError(null);
                      setChosen(choice);
                      setPrice("");
                    }}
                  >
                    <span>{choice.name}</span>
                    <span className="osv-choice__meta">
                      {choice.group} › {choice.subgroup}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!readOnly && chosen && (
        <div className="osv-confirm">
          <div className="osv-row__name">{chosen.name}</div>
          {priceNeeded ? (
            <label className="osv-field">
              <span>Price for this patient ₹</span>
              <input
                className="osv-input"
                inputMode="decimal"
                autoFocus
                value={price}
                onChange={(e) => setPrice(moneyTyped(e.target.value))}
              />
            </label>
          ) : (
            <div className="osv-row__meta">Billed at this patient's category rate.</div>
          )}
          <div className="osv-actions">
            <button
              type="button"
              className="osv-btn osv-btn--primary"
              disabled={add.isPending || (priceNeeded && !price.trim())}
              onClick={confirm}
            >
              Add for this patient
            </button>
            <button
              type="button"
              className="osv-btn osv-btn--ghost"
              onClick={() => {
                setChosen(null);
                setPrice("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className="osv-error">{error}</div>}
    </div>
  );
}
