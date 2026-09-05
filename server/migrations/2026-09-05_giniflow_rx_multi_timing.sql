-- BD is twice a day and TDS three times, but the draft row could hold ONE
-- timing, so a consultant prescribing "after breakfast and after dinner" could
-- record only half of it and the patient's card printed one dose.
-- `medications.when_to_take` has always been an array; the draft now matches.
-- timing_category stays as the earliest slot, which is what the medicine card
-- files a row under and what every existing reader still expects.
ALTER TABLE giniflow_rx_items ADD COLUMN IF NOT EXISTS timing_categories text[];

UPDATE giniflow_rx_items
   SET timing_categories = ARRAY[timing_category]
 WHERE timing_category IS NOT NULL AND timing_categories IS NULL;
