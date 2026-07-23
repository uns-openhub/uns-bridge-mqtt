import { z } from "zod";
import { bridgeSettingsSchema } from "@uns-kit/bridge-core";

// Extend this schema with project-specific configuration sections.
export const projectExtrasSchema = z.object({
  bridge: bridgeSettingsSchema,
});

export type ProjectExtras = z.infer<typeof projectExtrasSchema>;
