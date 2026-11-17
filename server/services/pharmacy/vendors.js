import { masterRecords } from "./masterRecords.js";

const vendors = masterRecords({
  table: "pharmacy_vendors",
  noun: "vendor",
  fields: [
    "name",
    "contact_person",
    "phone",
    "alt_phone",
    "email",
    "address",
    "city",
    "state",
    "pincode",
    "gstin",
    "pan",
    "drug_license_no",
    "drug_license_expiry",
    "payment_terms_days",
    "bank_name",
    "bank_account",
    "ifsc",
    "notes",
  ],
  duplicates: {
    pharmacy_vendors_name_key: "A vendor with this name already exists",
    pharmacy_vendors_gstin_key: "A vendor with this GSTIN already exists",
  },
  searchColumns: ["name", "contact_person", "phone", "gstin", "city"],
  prepare: (input) => ({ ...input, payment_terms_days: input.payment_terms_days ?? 0 }),
});

export const listVendors = (params) => vendors.list(params);

export const getVendor = (id) => vendors.get(id);
export const createVendor = (input, ctx) => vendors.create(input, ctx);
export const updateVendor = (id, input, ctx) => vendors.update(id, input, ctx);
export const setVendorActive = (id, isActive, ctx) => vendors.setActive(id, isActive, ctx);
