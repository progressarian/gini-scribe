import { z } from "zod";

export const notificationListQuerySchema = z.object({
  unread: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const notificationReadSchema = z
  .strictObject({
    ids: z.array(z.coerce.number().int().min(1)).max(200).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all || v.ids?.length, { message: "Say which notifications were read" });
