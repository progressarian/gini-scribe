export const TEST_FILE_PREFIX = "TESTSLOT-";

export const OPD_GROUPS = ["day", "week", "month"];

export const OPD_CONSULTANTS_SHOWN = 15;

export const OPD_DOCTORS_MAX = 50;

export const OPD_TIMES_MIN_VISITS = 20;

export const OPD_STATION_MIN_CASES = 5;

export const OPD_DASHBOARD_STATES = {
  booked: "All booked",
  came: "Came",
  completed: "Completed",
  in_progress: "In progress",
  not_closed: "Not closed in HealthRay",
  pending: "Pending",
  not_updated: "Not updated",
  did_not_come: "Did not come",
  no_show: "No-show",
  cancelled: "Cancelled",
};

export const OPD_DEFINITIONS = {
  page: "Days are India dates. Visits come from HealthRay appointments; times come from Gini Flow check-ins. Cancellations rebooked the same day, blocked patients and test bookings are left out.",
  came: "Appointments marked completed, checked in or in visit in HealthRay.",
  completed: "Appointments HealthRay marked completed.",
  in_progress: "Checked in or in visit today, not yet completed.",
  not_closed: "Checked in on an earlier day but never completed in HealthRay.",
  pending: "Booked for today and not yet arrived.",
  not_updated: "Booked for an earlier day and never marked in HealthRay.",
  did_not_come: "No-shows and cancellations, not counting cancellations rebooked the same day.",
  unique_patients: "Each person counted once, however many visits they had.",
  repeat_patients: "People with more than one visit in these dates.",
  visit_length:
    "Check-in to exit, for visits with an exit recorded by staff. The middle visit, so a few very long ones don't skew it.",
  waiting: "Check-in to the first consultation, for visits tracked on the floor.",
  on_time: "Finished visits within the journey target set in Time budgets.",
  heatmap: "By booked slot time; walk-ins use the time they were registered.",
};
