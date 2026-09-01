import { useCallback, useState } from "react";
import { useDictation, hasLiveCaptions } from "./useDictation";
import { parseSpokenVitals } from "../../shared/giniflowVitalsSpeech";

// Voice entry for the vitals station: dictation, then the deterministic parser.
// It fills the form and stops. The transcript stays on screen for read-back;
// the nurse presses Done.

export { hasLiveCaptions };

export function useVoiceVitals({ onFields } = {}) {
  const [result, setResult] = useState(null);

  const dictation = useDictation({
    onTranscript: (transcript) => {
      const parsed = parseSpokenVitals(transcript);
      setResult(parsed);
      if (parsed.filled.length) onFields?.(parsed.values);
    },
  });

  const start = useCallback(() => {
    setResult(null);
    dictation.start();
  }, [dictation]);

  const toggle = useCallback(
    () => (dictation.listening ? dictation.stop() : start()),
    [dictation, start],
  );

  const clear = useCallback(() => {
    setResult(null);
    dictation.clear();
  }, [dictation]);

  const { listening, busy, caption, error, live } = dictation;
  return { listening, busy, caption, result, error, toggle, clear, live };
}
