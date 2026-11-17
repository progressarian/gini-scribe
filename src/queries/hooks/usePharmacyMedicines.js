import { createMasterHooks } from "./usePharmacyMasters";

const medicines = createMasterHooks("/api/pharmacy/medicines", "pharmacy-medicines");

export const medicineKeys = medicines.keys;
export const useMedicineList = medicines.useList;
export const useCreateMedicine = medicines.useCreate;
export const useUpdateMedicine = medicines.useUpdate;
export const useSetMedicineActive = medicines.useSetActive;
