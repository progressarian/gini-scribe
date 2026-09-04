-- The doctor column on the floor is the consultant, never the MO — assigned_doctor_id
-- is only ever resolved against doctors.role = 'consultant'. The SLA strip on the
-- manager board still called it "doctor", which reads as the MO to the floor.

UPDATE giniflow_sla_config
   SET label = 'Consultant station',
       description = 'Consultation + prescription',
       updated_at = NOW()
 WHERE station = 'doctor';

UPDATE giniflow_sla_config
   SET label = 'Wait for consultant',
       description = 'After SD ready, before the consultant sees',
       updated_at = NOW()
 WHERE station = 'wait_doctor';
