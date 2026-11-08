import { z } from 'zod';
import type { FeedbackField, FeedbackTemplate } from './types.js';
import { weeklyFeedbackV1 } from './weekly.js';

/** Every version ever used must stay registered so historical feedback can render. */
const REGISTRY: FeedbackTemplate[] = [weeklyFeedbackV1];

/** Template used for new feedback. */
export const CURRENT_WEEKLY_TEMPLATE: FeedbackTemplate = weeklyFeedbackV1;

export function getTemplate(key: string, version: number): FeedbackTemplate | undefined {
  return REGISTRY.find((t) => t.key === key && t.version === version);
}

function fieldSchema(field: FeedbackField, strict: boolean): z.ZodType {
  let schema: z.ZodType;
  switch (field.type) {
    case 'rating':
      schema = z.number().int().min(1).max(field.max);
      break;
    case 'text':
    case 'textarea': {
      const base = z
        .string()
        .trim()
        .max(field.maxLength ?? 2000);
      schema = strict && field.required ? base.min(1, `${field.label} is required`) : base;
      break;
    }
    case 'select':
      schema = z.enum(field.options.map((o) => o.value) as [string, ...string[]]);
      break;
    case 'multiselect': {
      const base = z.array(z.enum(field.options.map((o) => o.value) as [string, ...string[]]));
      schema = strict && field.required ? base.min(1, `${field.label} is required`) : base;
      break;
    }
    case 'boolean':
      schema = z.boolean();
      break;
  }
  return strict && field.required ? schema : schema.optional().nullable();
}

/**
 * Builds a validator for a template. Drafts (`strict = false`) accept partial answers; submitting
 * (`strict = true`) enforces required fields. Unknown keys are stripped.
 */
export function answersSchema(template: FeedbackTemplate, strict: boolean) {
  const shape: Record<string, z.ZodType> = {};
  for (const section of template.sections) {
    for (const field of section.fields) shape[field.id] = fieldSchema(field, strict);
  }
  return z.object(shape);
}
