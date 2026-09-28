import { useCallback, useEffect, useRef, useState } from "react";

const VERSION = 1;
const WRITE_DELAY_MS = 200;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const loadedThisPage = new Set();

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const sameAs = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const blankOf = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.blank]));

const isBlank = (value, fields) =>
  Object.entries(fields).every(([name, field]) => sameAs(value[name], field.blank));

function forget(key) {
  try {
    storage()?.removeItem(key);
  } catch {
    return;
  }
}

function write(key, value, fields) {
  try {
    const store = storage();
    if (!store) return;
    if (isBlank(value, fields)) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ v: VERSION, savedAt: Date.now(), value }));
  } catch {
    return;
  }
}

function envelopeOf(raw) {
  const saved = JSON.parse(raw);
  const fresh =
    saved &&
    saved.v === VERSION &&
    Number.isFinite(saved.savedAt) &&
    Date.now() - saved.savedAt < STALE_AFTER_MS &&
    saved.value &&
    typeof saved.value === "object";
  return fresh ? saved : null;
}

function read(key, fields) {
  const blank = blankOf(fields);
  if (!key) return { value: blank, restored: false };
  const firstLoad = !loadedThisPage.has(key);
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return { value: blank, restored: false };
    const saved = envelopeOf(raw);
    if (!saved) {
      forget(key);
      return { value: blank, restored: false };
    }
    const value = Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        field.valid(saved.value[name]) ? saved.value[name] : field.blank,
      ]),
    );
    return { value, restored: firstLoad && !isBlank(value, fields) };
  } catch {
    forget(key);
    return { value: blank, restored: false };
  }
}

export function dropStaleForms(prefix) {
  try {
    const store = storage();
    if (!store) return;
    const keys = [];
    for (let at = 0; at < store.length; at += 1) {
      const key = store.key(at);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      let saved = null;
      try {
        saved = envelopeOf(store.getItem(key));
      } catch {
        saved = null;
      }
      if (!saved) store.removeItem(key);
    }
  } catch {
    return;
  }
}

export function useSavedForm(key, fields) {
  const [state, setState] = useState(() => ({
    key,
    touched: false,
    clears: 0,
    ...read(key, fields),
  }));
  const pending = useRef(null);
  const timer = useRef(null);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) write(next.key, next.value, fields);
  }, [fields]);

  let current = state;
  if (state.key !== key) {
    flush();
    current = { key, touched: false, clears: state.clears, ...read(key, fields) };
    setState(current);
  }

  useEffect(() => {
    if (state.key) loadedThisPage.add(state.key);
  }, [state.key]);

  useEffect(() => {
    if (!state.key || !state.touched) return;
    pending.current = { key: state.key, value: state.value };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, WRITE_DELAY_MS);
  }, [state, flush]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  const set = useCallback(
    (name, next) =>
      setState((was) => ({
        ...was,
        touched: true,
        value: {
          ...was.value,
          [name]: typeof next === "function" ? next(was.value[name]) : next,
        },
      })),
    [],
  );

  const drop = useCallback(
    (...names) =>
      setState((was) => ({
        ...was,
        touched: true,
        restored: false,
        value: {
          ...was.value,
          ...Object.fromEntries(names.map((name) => [name, fields[name].blank])),
        },
      })),
    [fields],
  );

  const clear = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    if (current.key) forget(current.key);
    setState((was) => ({
      key: was.key,
      touched: false,
      clears: was.clears + 1,
      restored: false,
      value: blankOf(fields),
    }));
  }, [current.key, fields]);

  return {
    value: current.value,
    restored: current.restored,
    clears: current.clears,
    dirty: !isBlank(current.value, fields),
    set,
    drop,
    clear,
  };
}
