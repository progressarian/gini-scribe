-- Free-text extra administration / application directives that don't fit
-- dose/frequency/timing/route — e.g. body site ("FOR LEGS"), test-dose /
-- infusion protocol ("AFTER TEST DOSE OF 20ML IN 10MINS, WAIT FOR 10MINS THEN
-- INFUSE REST OF THE IRON INFUSION"), dilution, taper schedule, special
-- precautions. Populated by the AI prescription extractor and shown on the
-- /visit medication card.

ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS instructions TEXT;
