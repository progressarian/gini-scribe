import { createMasterHooks } from "./usePharmacyMasters";

const vendors = createMasterHooks("/api/pharmacy/vendors", "pharmacy-vendors");

export const vendorKeys = vendors.keys;
export const useVendorList = vendors.useList;
export const useCreateVendor = vendors.useCreate;
export const useUpdateVendor = vendors.useUpdate;
export const useSetVendorActive = vendors.useSetActive;
