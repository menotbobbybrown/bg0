/**
 * PostHog survey shown once after a successful removal. Changing this ID shows
 * the new survey once, even to visitors who answered the previous one.
 */
export const RESULT_SURVEY_ID: string = '01a0bb11-7aee-0000-29d8-a9f80fa33910'

/**
 * Question ID of the result survey's optional "Anything else we should know?"
 * question. It is the only survey answer allowed to contain free text, and only
 * when the event belongs to `RESULT_SURVEY_ID`. An empty or unrecognized ID
 * accepts no free text, so every text answer is dropped.
 */
export const RESULT_SURVEY_COMMENT_QUESTION_ID: string = ''
