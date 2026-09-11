-- The one-line gloss beside each machine test, so an MO picking from the panel
-- can see what it measures without knowing the acronym.
--
-- Every other catalogue row has one — ECG already reads "Cardiac rhythm" — and
-- the MO station's own suite asserts it, which is how the four rows added today
-- were caught missing it.
--
-- The words describe what the test measures, not what it is for: an MO decides
-- the indication, and a gloss that guessed at one would be the catalogue giving
-- clinical advice.
UPDATE giniflow_test_catalog SET gloss = 'Leg artery pressure ratio'
 WHERE UPPER(test_name) = 'ABI' AND gloss IS NULL;

UPDATE giniflow_test_catalog SET gloss = 'Nerve vibration sense'
 WHERE UPPER(test_name) = 'VPT' AND gloss IS NULL;

UPDATE giniflow_test_catalog SET gloss = 'Retinal photograph'
 WHERE UPPER(test_name) = 'FUNDUS' AND gloss IS NULL;

UPDATE giniflow_test_catalog SET gloss = 'Exercise stress test'
 WHERE UPPER(test_name) = 'TMT' AND gloss IS NULL;
