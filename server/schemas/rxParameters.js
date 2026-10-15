import { z } from "zod";

const text = (max) => z.string().trim().max(max);

const row = z.strictObject({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,40}$/, "must be a short key of letters, numbers, - or _"),
  label: text(60).optional(),
  unit: text(20).optional(),
  value: z.union([text(40), z.number(), z.null()]).optional(),
  removed: z.boolean().optional(),
  show: z.boolean().optional(),
  custom: z.boolean().optional(),
  order: z.number().int().min(0).max(500).optional(),
});

export const rxParameterRowsSchema = z.strictObject({
  rows: z.array(row).max(60, "at most 60 parameters"),
});

const defaultRow = z.strictObject({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,40}$/, "must be a short key of letters, numbers, - or _"),
  label: text(60).min(1, "needs a name"),
  unit: text(20).optional().default(""),
  source: z
    .strictObject({
      vital: z.enum(["height", "weight", "bmi", "waist", "body_fat", "bp"]).optional(),
      labs: z.array(text(60).min(1)).max(10).optional(),
      sides: z.array(text(60).min(1)).max(4).optional(),
    })
    .nullable()
    .optional(),
});

export const rxParameterDefaultsSchema = z.strictObject({
  parameters: z
    .array(defaultRow)
    .min(1, "keep at least one parameter")
    .max(60, "at most 60 parameters")
    .refine((list) => new Set(list.map((p) => p.key)).size === list.length, "keys must be unique"),
});

export const RX_PARAMETER_LABELS = {
  rows: "Parameters",
  parameters: "Parameters",
  key: "Key",
  label: "Name",
  unit: "Unit",
  value: "Value",
};
