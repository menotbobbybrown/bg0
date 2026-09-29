import type { CaptureResult, Properties } from 'posthog-js'
import {
  RESULT_SURVEY_COMMENT_QUESTION_ID,
  RESULT_SURVEY_ID,
} from './survey-config'

const DATA_IMAGE_URL = /data:image\//i
const BLOB_URL = /\bblob:[^\s"')]+/gi
const PRIVATE_IMAGE_URL = '[private image URL]'
const SURVEY_SENT_EVENT = 'survey sent'
const ALLOWED_SURVEY_RESPONSES = new Set([
  'Great',
  'Good',
  'Needs work',
  'Unusable',
  'Background remained',
  'Part of the subject was removed',
  'Edges look rough',
  'Transparency looks wrong',
  'Too slow',
  'Product',
  'Person',
  'Pet or animal',
  'Logo or graphic',
  'Not at all likely',
  'Extremely likely',
  'Background removal quality',
  'Speed',
  'Ease of use',
  'Privacy',
  'Something else',
])

const ALLOWED_RECOMMENDATION_SCORE_MIN = 0
const ALLOWED_RECOMMENDATION_SCORE_MAX = 10

// posthog-js (through @posthog/core `buildSurveyResponseProperties`) writes
// each answer as `$survey_response_<question id>` and repeats it under a legacy
// index key: `$survey_response` for the first question, otherwise
// `$survey_response_<index>`.
const SURVEY_RESPONSE_KEY = /^\$survey_response(?:_.+)?$/
const LEGACY_SURVEY_RESPONSE_KEY = /^\$survey_response(?:_\d+)?$/
// Survey metadata PostHog adds to survey events. Every other `$survey_*`
// property, including the `$survey_questions` snapshot, is removed.
const ALLOWED_SURVEY_METADATA = new Set([
  '$survey_id',
  '$survey_name',
  '$survey_iteration',
  '$survey_iteration_start_date',
  '$survey_submission_id',
  '$survey_completed',
  '$survey_partially_completed',
  '$survey_language',
])
const SURVEY_COMMENT_MAX_LENGTH = 500
// Bounds regex work on pasted text. The redacted result is capped at
// SURVEY_COMMENT_MAX_LENGTH afterwards.
const SURVEY_COMMENT_SCAN_LENGTH = 4 * SURVEY_COMMENT_MAX_LENGTH

export interface SurveyTextConfig {
  /** Survey whose comment question may contain free text. */
  surveyId: string
  /** The one question whose answer may contain free text. */
  commentQuestionId: string
}

export type ReportableErrorContext =
  | {
      area: 'background_removal'
      reason:
        | 'decode-failed'
        | 'image-too-large'
        | 'inference-failed'
        | 'model-load-failed'
        | 'out-of-memory'
        | 'unsupported-image'
    }
  | { area: 'route' }
  | { area: 'unhandled_error' }
  | { area: 'unhandled_rejection' }

export type DurationBucket = '<5s' | '5-15s' | '15-30s' | '30-60s' | '>60s'

/** Coarse buckets keep timing from acting as a proxy for image size. */
export function durationBucket(durationMs: number): DurationBucket {
  if (!(durationMs >= 5_000)) return '<5s'
  if (durationMs < 15_000) return '5-15s'
  if (durationMs < 30_000) return '15-30s'
  if (durationMs < 60_000) return '30-60s'
  return '>60s'
}

/**
 * Filters a free-text survey answer before it leaves the browser. Returns an
 * empty string when nothing remains, which callers treat as unanswered.
 */
export function redactSurveyText(value: string) {
  return (
    value
      .trimStart()
      .slice(0, SURVEY_COMMENT_SCAN_LENGTH)
      // A data URI can contain whitespace and markup, so drop everything after
      // it rather than guess where it ends.
      .replace(/\bdata:[\s\S]*$/i, '[link]')
      .replace(/\b(?:blob|file):\S*/gi, '[link]')
      .replace(/\bhttps?:\/\/\S*/gi, '[link]')
      .replace(/\bwww\.\S*/gi, '[link]')
      // Any word containing @ counts as an email address, including partial
      // addresses cut off by the scan limit.
      .replace(/\S*@\S*/g, '[email]')
      // Visitors may name the image they processed. Keep its filename and
      // dimensions in the browser like every other image detail.
      .replace(
        /\S*\.(?:jpe?g|jpe|jfif|pjpe?g|pjp|png|apng|webp|gif|avif|heic|heics|heif|heifs|hif|bmp|tiff?|svg|dng|raw|psd)\b/gi,
        '[file]',
      )
      .replace(/\b\d{2,5}\s*[x×]\s*\d{2,5}\b/gi, '[size]')
      .replace(/\b\d{2,5}\s*(?:px|pixels)\b/gi, '[size]')
      .replace(/\+?\(?\d(?:[\s().-]{0,2}\d){6,}/g, '[number]')
      .trim()
      .slice(0, SURVEY_COMMENT_MAX_LENGTH)
      .trim()
  )
}

export function redactPrivateUrls(value: unknown): unknown {
  if (typeof value === 'string') {
    // A data URI can contain quotes, whitespace, and arbitrary SVG markup. Once
    // one appears, discard the complete property so no image content survives.
    if (DATA_IMAGE_URL.test(value)) return PRIVATE_IMAGE_URL
    return value.replace(BLOB_URL, PRIVATE_IMAGE_URL)
  }
  if (Array.isArray(value)) return value.map(redactPrivateUrls)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactPrivateUrls(nested),
      ]),
    )
  }
  return value
}

function safeProperties(properties: Properties | undefined) {
  if (!properties) return undefined
  const sanitized = redactPrivateUrls(properties) as Properties
  delete sanitized.$current_url
  delete sanitized.$referrer
  delete sanitized.$initial_current_url
  delete sanitized.$initial_referrer
  return sanitized
}

export function createCaptureSanitizer(surveyText: SurveyTextConfig) {
  return (capture: CaptureResult | null): CaptureResult | null => {
    if (!capture) return null
    let properties = safeProperties(capture.properties) ?? {}
    const isSurveyEvent =
      capture.event.startsWith('survey ') ||
      Object.keys(properties).some((key) => key.startsWith('$survey_'))
    if (isSurveyEvent) {
      const surveyProperties = sanitizeSurveyProperties(
        capture.properties ?? {},
        properties,
        surveyText,
      )
      if (!surveyProperties) return null
      if (
        capture.event === SURVEY_SENT_EVENT &&
        !Object.keys(surveyProperties).some((key) =>
          SURVEY_RESPONSE_KEY.test(key),
        )
      ) {
        return null
      }
      properties = surveyProperties
    }
    return {
      ...capture,
      properties,
      $set: safeProperties(capture.$set),
      $set_once: safeProperties(capture.$set_once),
    }
  }
}

export const sanitizeCapture = createCaptureSanitizer({
  surveyId: RESULT_SURVEY_ID,
  commentQuestionId: RESULT_SURVEY_COMMENT_QUESTION_ID,
})

/**
 * Keeps only allowlisted survey answers and metadata. Returns null when any
 * answer other than the configured comment is outside the allowlist. `raw` is
 * the unmodified capture; `redacted` has passed through `redactPrivateUrls`.
 * Applies to sent, dismissed, and abandoned events, which all carry answers.
 */
function sanitizeSurveyProperties(
  raw: Properties,
  redacted: Properties,
  { surveyId, commentQuestionId }: SurveyTextConfig,
): Properties | null {
  const commentKey = commentResponseKey(raw, surveyId, commentQuestionId)
  const rawComment: unknown = commentKey ? raw[commentKey] : undefined
  if (
    rawComment !== undefined &&
    rawComment !== null &&
    typeof rawComment !== 'string'
  ) {
    return null
  }
  const comment =
    typeof rawComment === 'string' ? redactSurveyText(rawComment) : ''

  const result: Properties = {}
  for (const [key, value] of Object.entries(redacted)) {
    if (!key.startsWith('$survey_')) {
      // PostHog attaches a replay URL to survey events. Replay is disabled.
      if (key !== 'sessionRecordingUrl') result[key] = value
      continue
    }
    if (!SURVEY_RESPONSE_KEY.test(key)) {
      if (ALLOWED_SURVEY_METADATA.has(key) && isSurveyMetadataValue(value)) {
        result[key] = value
      }
      continue
    }
    const isComment =
      key === commentKey ||
      (typeof rawComment === 'string' &&
        LEGACY_SURVEY_RESPONSE_KEY.test(key) &&
        raw[key] === rawComment)
    if (isComment) {
      if (comment) result[key] = comment
      continue
    }
    // Skipped optional questions carry no answer.
    if (value === null || value === undefined || value === '') continue
    if (!isAllowedChoiceResponse(value)) return null
    result[key] = value
  }
  return result
}

// Metadata comes from the survey definition and posthog-js: IDs, the survey
// name, iteration numbers, dates, flags, and a language code. Anything else
// is unexpected and dropped.
function isSurveyMetadataValue(value: unknown) {
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && value.length <= 200
}

function commentResponseKey(
  raw: Properties,
  surveyId: string,
  commentQuestionId: string,
) {
  if (!surveyId || raw.$survey_id !== surveyId) return undefined
  // A numeric ID would collide with PostHog's legacy index keys.
  if (!/^[\w-]+$/.test(commentQuestionId) || /^\d+$/.test(commentQuestionId)) {
    return undefined
  }
  return `$survey_response_${commentQuestionId}`
}

function isAllowedChoiceResponse(value: unknown) {
  if (typeof value === 'string') {
    return ALLOWED_SURVEY_RESPONSES.has(value) || isRecommendationScore(value)
  }
  if (typeof value === 'number') return isRecommendationScore(value)
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (answer) =>
        (typeof answer === 'string' || typeof answer === 'number') &&
        (ALLOWED_SURVEY_RESPONSES.has(String(answer)) ||
          isRecommendationScore(answer)),
    )
  )
}

function isRecommendationScore(value: string | number) {
  if (typeof value === 'string' && !/^\d{1,2}$/.test(value)) return false
  const score = typeof value === 'number' ? value : Number(value)
  return (
    Number.isInteger(score) &&
    score >= ALLOWED_RECOMMENDATION_SCORE_MIN &&
    score <= ALLOWED_RECOMMENDATION_SCORE_MAX
  )
}

export function createReportableError(
  originalError: unknown,
  context: ReportableErrorContext,
  applicationOrigin = '',
) {
  const message =
    context.area === 'background_removal'
      ? `Background removal failed: ${context.reason}`
      : context.area === 'route'
        ? 'Application route failed'
        : context.area === 'unhandled_error'
          ? 'Unhandled application error'
          : 'Unhandled promise rejection'
  const error = new Error(message)
  error.name = 'BG0Error'
  const frames = extractApplicationFrames(originalError, applicationOrigin)
  if (frames.length > 0) {
    error.stack = `${error.name}: ${error.message}\n${frames.join('\n')}`
  }
  return error
}

function extractApplicationFrames(error: unknown, applicationOrigin: string) {
  if (!(error instanceof Error) || !error.stack || !applicationOrigin) return []

  return error.stack.split('\n').flatMap((line) => {
    const match = line.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/)
    if (!match) return []

    try {
      const source = new URL(match[1])
      const isApplicationCode =
        source.origin === applicationOrigin &&
        (/^\/assets\/[\w./-]+\.js$/.test(source.pathname) ||
          /^\/src\/[\w./-]+\.(?:js|jsx|ts|tsx)$/.test(source.pathname))
      if (!isApplicationCode) return []
      source.search = ''
      source.hash = ''
      return [`    at ${source.href}:${match[2]}:${match[3]}`]
    } catch {
      return []
    }
  })
}
