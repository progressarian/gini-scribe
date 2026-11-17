export const DUE_SQL = `(CASE WHEN b.bill_type = 'invoice' AND b.status = 'final'
  THEN b.net_amount - b.paid_amount - COALESCE((SELECT SUM(c.due_adjusted) FROM pharmacy_bills c
    WHERE c.original_bill_id = b.id AND c.status = 'final'), 0)
  - COALESCE((SELECT SUM(w.amount) FROM pharmacy_account_entries w
    WHERE w.bill_id = b.id AND w.kind = 'write_off'), 0) ELSE 0 END)::numeric(12, 2)`;

export const PATIENT_DUE_SQL = (patient) => `(SELECT COALESCE(SUM(${DUE_SQL}), 0)::numeric(12, 2)
    FROM pharmacy_bills b WHERE b.patient_id = ${patient} AND b.status = 'final'
     AND b.bill_type = 'invoice' AND b.pay_later AND b.paid_amount < b.net_amount)`;
