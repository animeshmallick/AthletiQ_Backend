import type { FeedbackTemplate } from './types.js';

/**
 * Weekly student progress report.
 *
 * ✏️  Edit this file to change the form coaches fill in every week. Read ./types.ts for the
 * versioning rules (bump `version` when you add/remove fields or change what one means).
 */
const ratingCaptions = {
  1: 'Needs attention',
  2: 'Developing',
  3: 'Good',
  4: 'Very good',
  5: 'Excellent',
};

export const weeklyFeedbackV1: FeedbackTemplate = {
  key: 'weekly',
  version: 1,
  title: 'Weekly progress report',
  description: "A quick snapshot of the student's week. Attendance is filled in automatically.",
  sections: [
    {
      id: 'skills',
      title: 'Skills & performance',
      fields: [
        {
          id: 'technique',
          type: 'rating',
          label: 'Technique',
          max: 5,
          required: true,
          captions: ratingCaptions,
        },
        {
          id: 'fitness',
          type: 'rating',
          label: 'Fitness & stamina',
          max: 5,
          required: true,
          captions: ratingCaptions,
        },
        {
          id: 'game_sense',
          type: 'rating',
          label: 'Game sense & decision making',
          max: 5,
          required: true,
          captions: ratingCaptions,
        },
      ],
    },
    {
      id: 'attitude',
      title: 'Attitude',
      fields: [
        {
          id: 'discipline',
          type: 'rating',
          label: 'Discipline & punctuality',
          max: 5,
          required: true,
          captions: ratingCaptions,
        },
        {
          id: 'effort',
          type: 'rating',
          label: 'Effort & focus',
          max: 5,
          required: true,
          captions: ratingCaptions,
        },
        {
          id: 'teamwork',
          type: 'rating',
          label: 'Teamwork & sportsmanship',
          max: 5,
          required: true,
          captions: ratingCaptions,
        },
      ],
    },
    {
      id: 'summary',
      title: 'Coach notes',
      fields: [
        {
          id: 'overall',
          type: 'select',
          label: 'Overall progress this week',
          required: true,
          options: [
            { value: 'improving', label: 'Improving' },
            { value: 'steady', label: 'Steady' },
            { value: 'declining', label: 'Needs a push' },
          ],
        },
        {
          id: 'highlights',
          type: 'textarea',
          label: 'Highlights',
          placeholder: 'What went well this week?',
          maxLength: 1000,
          required: true,
        },
        {
          id: 'improvements',
          type: 'textarea',
          label: 'Areas to improve',
          placeholder: 'What should the student focus on next?',
          maxLength: 1000,
          required: true,
        },
        {
          id: 'home_practice',
          type: 'textarea',
          label: 'Suggested home practice',
          maxLength: 500,
        },
        {
          id: 'injury_concern',
          type: 'boolean',
          label: 'Any injury or health concern noticed?',
        },
      ],
    },
  ],
};
