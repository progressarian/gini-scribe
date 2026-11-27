export const REPORT_RELEASE_KIND = "report_release";

export const RELEASE_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
};

export const RELEASE_STATUSES = Object.values(RELEASE_STATUS);

export const RELEASE_STATUS_LABEL = {
  pending: "Waiting for approval",
  approved: "Approved to release",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export const RELEASE_REASON_MAX = 500;

export const RELEASE_PAYMENT_PENDING =
  "Payment pending — this home-collection bill is on credit. Ask an admin to approve releasing the report, or collect the payment first";
