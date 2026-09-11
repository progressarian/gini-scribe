-- The five machine tests, so they can be ordered at all
-- (docs/gini-flow/39-HYBRID-FLOOR-PLAN.md — Option A: every test is raised in
-- Scribe, so every test needs a catalogue row with a price to bill).
--
-- ABI, VPT, Fundus and TMT were in no catalogue at all, so the machine room
-- refused every order: there was no price, and an order for zero would sit at
-- `pending` with nothing for reception to collect. ECG existed but was filed as
-- a LAB test, which sent it to the blood bench and told a phlebotomist to draw a
-- sample for an electrocardiogram.
--
-- PLACEHOLDER PRICES, asked for as a default so the floor can start ordering
-- while the real rate card is put together. `source = 'prototype_placeholder'`
-- is deliberate and load-bearing: reception's payment screen reads it and shows
-- "these are not real prices" until somebody replaces them, and the whole
-- catalogue is already flagged that way. Nothing here is a tariff.
INSERT INTO giniflow_test_catalog (test_name, category, price, is_active, source)
VALUES
  ('ABI', 'machine', 500, TRUE, 'prototype_placeholder'),
  ('VPT', 'machine', 500, TRUE, 'prototype_placeholder'),
  ('Fundus', 'machine', 500, TRUE, 'prototype_placeholder'),
  ('TMT', 'machine', 500, TRUE, 'prototype_placeholder')
ON CONFLICT (test_name) DO UPDATE
  SET category = 'machine',
      is_active = TRUE,
      updated_at = NOW();

-- ECG keeps its existing ₹300 — that figure was already there — and only moves
-- to the room that actually runs it.
UPDATE giniflow_test_catalog
   SET category = 'machine', updated_at = NOW()
 WHERE UPPER(test_name) = 'ECG';
