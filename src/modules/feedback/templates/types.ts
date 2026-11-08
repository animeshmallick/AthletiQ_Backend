/**
 * Feedback templates are defined in code (see ./weekly.ts). Each saved feedback records the
 * template key + version it was written against, so you can freely evolve the template:
 *
 *  - Wording / help-text / option label tweaks → edit in place, keep the version.
 *  - Adding, removing or changing the meaning of fields → copy to a new version, bump
 *    `version`, and register it in ./index.ts. Old feedback keeps rendering with its version.
 */

interface BaseField {
  /** Stable key stored in the answers JSON. Never reuse a key for a different meaning. */
  id: string;
  label: string;
  help?: string;
  required?: boolean;
}

export interface RatingField extends BaseField {
  type: 'rating';
  /** Ratings are 1..max. */
  max: number;
  /** Optional captions per value, e.g. { 1: 'Needs work', 5: 'Excellent' }. */
  captions?: Record<number, string>;
}

export interface TextField extends BaseField {
  type: 'text' | 'textarea';
  maxLength?: number;
  placeholder?: string;
}

export interface SelectField extends BaseField {
  type: 'select' | 'multiselect';
  options: { value: string; label: string }[];
}

export interface BooleanField extends BaseField {
  type: 'boolean';
}

export type FeedbackField = RatingField | TextField | SelectField | BooleanField;

export interface FeedbackSection {
  id: string;
  title: string;
  description?: string;
  fields: FeedbackField[];
}

export interface FeedbackTemplate {
  key: string;
  version: number;
  title: string;
  description?: string;
  sections: FeedbackSection[];
}
