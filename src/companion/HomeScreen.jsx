import "./HomeScreen.css";
import { useEffect, useRef, useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import useCompanionStore from "../stores/companionStore";

export default function HomeScreen() {
  const navigate = useNavigate();
  const {
    patients,
    totalPatients,
    searchText,
    setSearchText,
    setSelectedPatient,
    loadMore,
    loadPatients,
    hasMore,
    loadingPatients,
  } = useCompanionStore();

  // Refresh patient list (with updated visit_count) on every mount
  useEffect(() => {
    loadPatients();
  }, []);
  const sentinelRef = useRef(null);
  const [localSearch, setLocalSearch] = useState(searchText);
  const debounceRef = useRef(null);

  // Debounce search → server
  const handleSearch = (val) => {
    setLocalSearch(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchText(val), 400);
  };

  // Infinite scroll
  const onIntersect = useCallback(
    (entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingPatients) {
        loadMore();
      }
    },
    [hasMore, loadingPatients, loadMore],
  );

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(onIntersect, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [onIntersect]);

  const handleClick = (p) => {
    setSelectedPatient(p);
    navigate(`/companion/record/${p.id}`);
  };

  return (
    <div>
      <div className="home__header">
        <div className="home__header-row">
          <div>
            <div className="home__title">Gini Companion</div>
            <div className="home__subtitle">
              {new Date().toLocaleDateString("en-IN", {
                weekday: "short",
                day: "numeric",
                month: "short",
              })}{" "}
              • Gini Advanced Care
            </div>
          </div>
          <div className="home__badge">{totalPatients} patients</div>
        </div>
      </div>
      <div className="home__body">
        <input
          value={localSearch}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search name, file no, phone..."
          className="home__search"
        />
        <div className="home__list">
          {patients.map((p) => (
            <div key={p.id} onClick={() => handleClick(p)} className="home__patient">
              <div className="home__avatar">{(p.name || "?")[0].toUpperCase()}</div>
              <div className="home__info">
                <div className="home__name">{p.name}</div>
                <div className="home__details">
                  {p.age}Y/{p.sex?.[0]} • {p.file_no}
                </div>
              </div>
              <div className="home__stats">
                <div className="home__visits">{p.visit_count || 0} visits</div>
                <div className="home__phone">{p.phone}</div>
              </div>
            </div>
          ))}
          {hasMore && (
            <div ref={sentinelRef} className="home__loading-more">
              {loadingPatients ? "Loading..." : "Scroll for more"}
            </div>
          )}
          {!hasMore && patients.length > 0 && (
            <div className="home__end">
              Showing all {patients.length} of {totalPatients}
            </div>
          )}
          {!loadingPatients && patients.length === 0 && (
            <div className="home__empty">No patients found</div>
          )}
        </div>
      </div>
    </div>
  );
}
