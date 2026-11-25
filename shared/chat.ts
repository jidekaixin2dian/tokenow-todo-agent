import { z } from "zod";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
});

export type ChatMessage = z.infer<typeof messageSchema>;

export const chatRequestSchema = z.object({
  conversationId: z.uuid().optional(),
  messages: z
    .array(messageSchema)
    .min(1)
    .refine((messages) => messages.at(-1)?.role === "user"),
});
