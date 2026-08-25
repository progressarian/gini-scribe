-- blood_report could not be deleted: a live visit references it (a stage added
-- by hand from the "+ Add step" picker before that picker excluded background
-- stages). Deactivating achieves the same thing — invisible everywhere, in no
-- template — without rewriting a patient's journey history.
UPDATE flow_step_catalog SET is_active = FALSE WHERE id = 'blood_report';
