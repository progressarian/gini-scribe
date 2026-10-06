import { z } from "zod";

export const pharmacyStockListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  filter: z.enum(["all", "in_stock", "out_of_stock", "not_linked"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyStockHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyStockFileQuerySchema = z.object({
  fileName: z.string().trim().min(1, "Choose a file to upload").max(200),
});

export const pharmacyStockLinkSchema = z.object({
  medicineName: z
    .string()
    .trim()
    .min(2, "Enter the medicine name as it is written on prescriptions")
    .max(200),
});

export const pharmacyNeededOrderSchema = z.object({
  medicineKey: z.string().trim().min(1, "Choose the medicine").max(200),
  medicineName: z.string().trim().min(1, "Choose the medicine").max(200),
  note: z.string().trim().max(500).nullish(),
});

export const pharmacyNeededClearSchema = z.object({
  medicineKey: z.string().trim().min(1, "Choose the medicine").max(200),
});

export const pharmacyMedicineRequestSchema = z.object({
  medicineName: z.string().trim().min(2, "Type the medicine name").max(200),
  visitId: z.string().uuid().nullish(),
});
