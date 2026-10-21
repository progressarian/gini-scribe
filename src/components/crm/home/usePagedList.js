import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import { errorText } from "../import/importText.js";

export default function usePagedList(url, params, refreshKey, failText) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify(params);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get(url, { params })
      .then(({ data: body }) => !cancelled && setData(body))
      .catch((e) => !cancelled && setErr(errorText(e, failText)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [url, key, refreshKey, retry]);

  return { data, loading, err, retry: () => setRetry((n) => n + 1) };
}
