UPDATE appointments
   SET booking_status = 'booked'
 WHERE booking_status IS NULL
   AND appointment_date >= CURRENT_DATE
   AND COALESCE(status, '') NOT IN ('no_show', 'cancelled');
