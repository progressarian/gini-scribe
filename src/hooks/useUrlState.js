import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const storageKey = (pathname) => `gini:filters:${pathname}`;

const readSaved = (pathname) => {
  try {
    return sessionStorage.getItem(storageKey(pathname)) ?? "";
  } catch {
    return "";
  }
};

const writeSaved = (pathname, search) => {
  try {
    if (search) sessionStorage.setItem(storageKey(pathname), search);
    else sessionStorage.removeItem(storageKey(pathname));
  } catch {
    return;
  }
};

let pending = null;

const liveSearch = (pathname) =>
  window.location.pathname === pathname
    ? window.location.search || readSaved(pathname)
    : readSaved(pathname);

function queueWrite(navigate, pathname, apply) {
  if (!pending || pending.pathname !== pathname) {
    pending = { pathname, params: new URLSearchParams(liveSearch(pathname)) };
    queueMicrotask(() => {
      const { params } = pending;
      pending = null;
      const search = params.toString();
      writeSaved(pathname, search);
      navigate({ pathname, search: search ? `?${search}` : "" }, { replace: true });
    });
  }
  apply(pending.params);
}

function useFilterParams() {
  const location = useLocation();
  const navigate = useNavigate();
  const saved = location.search ? "" : readSaved(location.pathname);
  const current = location.search || saved;
  const params = useMemo(() => new URLSearchParams(current), [current]);

  useEffect(() => {
    if (saved) navigate({ search: saved }, { replace: true });
  }, [saved, navigate]);

  return { location, navigate, params };
}

const asText = (value) => String(value);

export default function useUrlState(key, fallback, { parse = (raw) => raw, format = asText } = {}) {
  const { location, navigate, params } = useFilterParams();
  const raw = params.get(key);
  const value = raw === null ? fallback : parse(raw);
  const latest = useRef(value);
  latest.current = value;

  const setValue = useCallback(
    (next) => {
      const resolved = typeof next === "function" ? next(latest.current) : next;
      latest.current = resolved;
      queueWrite(navigate, location.pathname, (out) => {
        if (resolved === fallback || resolved === "" || resolved === null || resolved === undefined)
          out.delete(key);
        else out.set(key, format(resolved));
      });
    },
    [navigate, location.pathname, key, fallback, format],
  );

  return [value, setValue];
}

export const asNumber = { parse: (raw) => Number(raw) || 0 };
export const asFlag = { parse: (raw) => raw === "1", format: (value) => (value ? "1" : "") };

export function useUrlSearch(key, onCommit) {
  const [q, setQ] = useUrlState(key, "");
  const [search, setSearch] = useState(q);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = search.trim().length >= 2 ? search.trim() : "";
      if (next === q) return;
      setQ(next);
      commit.current?.();
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const clear = useCallback(() => {
    setSearch("");
    setQ("");
  }, [setQ]);

  return { search, setSearch, q, clear };
}
