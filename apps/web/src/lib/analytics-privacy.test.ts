import { describe, expect, test } from 'bun:test'
import type { CaptureResult } from 'posthog-js'
import {
  createCaptureSanitizer,
  createReportableError,
  durationBucket,
  redactPrivateUrls,
  redactSurveyText,
  sanitizeCapture,
} from './analytics-privacy'

const SURVEY_ID = 'result-survey'
const COMMENT_ID = 'comment-question'
const COMMENT_KEY = `$survey_response_${COMMENT_ID}`
const sanitizeResultSurvey = createCaptureSanitizer({
  surveyId: SURVEY_ID,
  commentQuestionId: COMMENT_ID,
})

function surveyEvent(
  properties: Record<string, unknown>,
  event = 'survey sent',
) {
  return { event, properties } as unknown as CaptureResult
}

describe('analytics privacy', () => {
  test('redacts a complete quoted SVG data URI', () => {
    const value =
      'decode failed: data:image/svg+xml,<svg viewBox="0 0"><text>SECRET_SVG_PAYLOAD</text></svg>'

    expect(redactPrivateUrls(value)).toBe('[private image URL]')
  })

  test('redacts nested capture fields and removes browsing URLs', () => {
    const capture = {
      event: '$exception',
      properties: {
        nested: {
          source:
            'data:image/svg+xml,<svg viewBox="0 0">SECRET_PROPERTIES</svg>',
        },
        $current_url: 'https://bg0.dev/private-route',
      },
      $set: {
        preview: 'blob:https://bg0.dev/SECRET_SET',
        $referrer: 'https://example.com/private',
      },
      $set_once: {
        preview:
          'prefix data:image/png;base64,SECRET_SET_ONCE with trailing text',
        $initial_current_url: 'https://bg0.dev/private-route',
      },
    } as unknown as CaptureResult

    const result = sanitizeCapture(capture)
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('private-route')
    expect(serialized).not.toContain('example.com')
    expect(result?.properties).toEqual({
      nested: { source: '[private image URL]' },
    })
    expect(result?.$set).toEqual({ preview: '[private image URL]' })
    expect(result?.$set_once).toEqual({ preview: '[private image URL]' })
  })

  test('leaves ordinary error context intact', () => {
    expect(redactPrivateUrls('model initialization failed')).toBe(
      'model initialization failed',
    )
  })

  test('allows only the controlled multiple-choice survey schema', () => {
    const allowed = sanitizeCapture({
      event: 'survey sent',
      properties: {
        $survey_id: 'result-quality',
        $survey_response_rating: 'Good',
        $survey_response_problem: ['Edges look rough'],
      },
    } as unknown as CaptureResult)
    const privateText = sanitizeCapture({
      event: 'survey sent',
      properties: {
        $survey_response_comment:
          'vacation.png was 4032x3024: https://example.com/photo.jpg',
      },
    } as unknown as CaptureResult)

    expect(allowed).not.toBeNull()
    expect(privateText).toBeNull()
  })

  test('allows recommendation scores and predefined follow-up reasons', () => {
    const allowed = sanitizeCapture({
      event: 'survey sent',
      properties: {
        $survey_id: 'recommendation',
        $survey_response_rating: 9,
        $survey_response_reason: ['Privacy'],
      },
    } as unknown as CaptureResult)
    const outOfRange = sanitizeCapture({
      event: 'survey sent',
      properties: {
        $survey_id: 'recommendation',
        $survey_response_rating: 11,
      },
    } as unknown as CaptureResult)

    expect(allowed).not.toBeNull()
    expect(outOfRange).toBeNull()
  })

  test('removes dashboard-controlled survey question snapshots', () => {
    const allowed = sanitizeCapture({
      event: 'survey sent',
      properties: {
        $survey_id: 'recommendation',
        $survey_response_rating: 9,
        $survey_questions: [
          {
            question: 'Why?',
            response: 'vacation.png at https://example.com/photo.jpg',
          },
        ],
      },
    } as unknown as CaptureResult)

    expect(allowed).not.toBeNull()
    expect(allowed?.properties.$survey_questions).toBeUndefined()
  })

  test('allows every choice in the result survey', () => {
    const good = sanitizeResultSurvey(
      surveyEvent({
        $survey_id: SURVEY_ID,
        '$survey_response_q-rating': 'Great',
        $survey_response: 'Great',
        '$survey_response_q-subject': 'Pet or animal',
        $survey_response_1: 'Pet or animal',
        '$survey_response_q-recommend': 10,
        $survey_response_2: 10,
      }),
    )
    const poor = sanitizeResultSurvey(
      surveyEvent({
        $survey_id: SURVEY_ID,
        '$survey_response_q-rating': 'Unusable',
        '$survey_response_q-problem': [
          'Background remained',
          'Part of the subject was removed',
          'Edges look rough',
          'Transparency looks wrong',
          'Too slow',
          'Something else',
        ],
        '$survey_response_q-subject': 'Logo or graphic',
      }),
    )

    expect(good?.properties).toMatchObject({
      '$survey_response_q-subject': 'Pet or animal',
      '$survey_response_q-recommend': 10,
    })
    expect(poor).not.toBeNull()
    for (const subject of ['Product', 'Person', 'Something else']) {
      expect(
        sanitizeResultSurvey(
          surveyEvent({
            $survey_id: SURVEY_ID,
            '$survey_response_q-subject': subject,
          }),
        ),
      ).not.toBeNull()
    }
  })

  test('drops text on any key other than the comment question', () => {
    const cases: Record<string, unknown>[] = [
      // An open "Something else" choice on a multiple-choice question.
      { '$survey_response_q-problem': ['Edges look rough', 'my cat Luna'] },
      { '$survey_response_q-subject': 'my passport' },
      // The comment question ID on another survey.
      { $survey_id: 'other-survey', [COMMENT_KEY]: 'hello' },
      // A legacy index key that does not mirror the comment answer.
      { $survey_response_4: 'vacation.png' },
    ]
    for (const properties of cases) {
      expect(
        sanitizeResultSurvey(
          surveyEvent({ $survey_id: SURVEY_ID, ...properties }),
        ),
      ).toBeNull()
    }
    // The production sanitizer has no comment question configured yet.
    expect(
      sanitizeCapture(
        surveyEvent({
          $survey_id: SURVEY_ID,
          [COMMENT_KEY]: 'hello',
          '$survey_response_q-rating': 'Good',
        }),
      ),
    ).toBeNull()
    // Dismissed and abandoned events carry partial answers too.
    expect(
      sanitizeResultSurvey(
        surveyEvent(
          { $survey_id: SURVEY_ID, '$survey_response_q-subject': 'my kid' },
          'survey dismissed',
        ),
      ),
    ).toBeNull()
    expect(
      sanitizeResultSurvey(
        surveyEvent(
          { $survey_id: SURVEY_ID, '$survey_response_q-subject': 'my kid' },
          'survey abandoned',
        ),
      ),
    ).toBeNull()
  })

  test('redacts the comment answer and its legacy index key', () => {
    const comment =
      '  Hair was cut off. Email me at jane.doe@example.com or call +1 (555) 123-4567, see https://example.com/a.png  '
    const result = sanitizeResultSurvey(
      surveyEvent({
        $survey_id: SURVEY_ID,
        '$survey_response_q-rating': 'Needs work',
        [COMMENT_KEY]: comment,
        $survey_response_4: comment,
        $survey_questions: [{ question: 'Anything else?', response: comment }],
        $survey_secret: 'smuggled text',
        sessionRecordingUrl: 'https://us.posthog.com/replay/1',
      }),
    )
    const expected =
      'Hair was cut off. Email me at [email] or call [number], see [link]'

    expect(result?.properties).toEqual({
      $survey_id: SURVEY_ID,
      '$survey_response_q-rating': 'Needs work',
      [COMMENT_KEY]: expected,
      $survey_response_4: expected,
    })
  })

  test('redacts links, image URIs, emails, and long numbers', () => {
    expect(redactSurveyText('see www.example.com/photo now')).toBe(
      'see [link] now',
    )
    expect(redactSurveyText('http://a.test and HTTPS://b.test/x')).toBe(
      '[link] and [link]',
    )
    expect(redactSurveyText('preview blob:https://bg0.dev/1234 broke')).toBe(
      'preview [link] broke',
    )
    expect(
      redactSurveyText('pasted data:image/svg+xml,<svg> <text>SECRET</text>'),
    ).toBe('pasted [link]')
    expect(redactSurveyText('me@host.example')).toBe('[email]')
    expect(redactSurveyText('order 5551234567 and 555-123-4567')).toBe(
      'order [number] and [number]',
    )
    expect(redactSurveyText('took 12 seconds on 2 tries')).toBe(
      'took 12 seconds on 2 tries',
    )
  })

  test('redacts image filenames and dimensions', () => {
    expect(redactSurveyText('IMG_2041.HEIC lost its hair')).toBe(
      '[file] lost its hair',
    )
    expect(redactSurveyText('my dog.png, 4032 x 3024 photo')).toBe(
      'my [file], [size] photo',
    )
    expect(redactSurveyText('a 1920×1080 banner at 800px')).toBe(
      'a [size] banner at [size]',
    )
  })

  test('redacts every image extension BG0 accepts, through the sanitizer', () => {
    const names = [
      'vacation.hif',
      'scan.jfif',
      'old.jpe',
      'burst.heics',
      'still.heifs',
      'web.pjpeg',
      'loop.apng',
    ]
    for (const name of names) {
      const result = sanitizeResultSurvey(
        surveyEvent({
          $survey_id: SURVEY_ID,
          [COMMENT_KEY]: `${name} lost its edges`,
          $survey_response: `${name} lost its edges`,
        }),
      )
      expect(result?.properties[COMMENT_KEY]).toBe('[file] lost its edges')
      expect(result?.properties.$survey_response).toBe('[file] lost its edges')
    }
  })

  test('keeps a comment that follows a long run of whitespace', () => {
    expect(redactSurveyText(`${' '.repeat(5000)}edges were soft`)).toBe(
      'edges were soft',
    )
  })

  test('drops survey metadata that is not a short primitive', () => {
    const result = sanitizeResultSurvey(
      surveyEvent({
        $survey_id: SURVEY_ID,
        $survey_name: 'x'.repeat(201),
        $survey_iteration: 2,
        $survey_completed: true,
        $survey_language: { nested: 'value' },
        '$survey_response_q-rating': 'Great',
      }),
    )

    expect(result?.properties).toEqual({
      $survey_id: SURVEY_ID,
      $survey_iteration: 2,
      $survey_completed: true,
      '$survey_response_q-rating': 'Great',
    })
  })

  test('caps the comment at 500 characters and treats blank as unanswered', () => {
    expect(redactSurveyText('a'.repeat(5000))).toHaveLength(500)
    expect(redactSurveyText(`${'b'.repeat(499)} tail`)).toBe('b'.repeat(499))

    const blank = sanitizeResultSurvey(
      surveyEvent({
        $survey_id: SURVEY_ID,
        '$survey_response_q-rating': 'Unusable',
        [COMMENT_KEY]: '   ',
      }),
    )
    const onlyBlank = sanitizeResultSurvey(
      surveyEvent({ $survey_id: SURVEY_ID, [COMMENT_KEY]: '' }),
    )

    expect(blank?.properties).toEqual({
      $survey_id: SURVEY_ID,
      '$survey_response_q-rating': 'Unusable',
    })
    expect(onlyBlank).toBeNull()
  })

  test('rejects a non-text comment and ignores unusable comment IDs', () => {
    expect(
      sanitizeResultSurvey(
        surveyEvent({ $survey_id: SURVEY_ID, [COMMENT_KEY]: ['text'] }),
      ),
    ).toBeNull()
    for (const commentQuestionId of ['', '4', 'bad id']) {
      const sanitize = createCaptureSanitizer({
        surveyId: SURVEY_ID,
        commentQuestionId,
      })
      expect(
        sanitize(
          surveyEvent({
            $survey_id: SURVEY_ID,
            [`$survey_response_${commentQuestionId}`]: 'free text',
          }),
        ),
      ).toBeNull()
    }
  })

  test('buckets removal durations coarsely', () => {
    expect(durationBucket(0)).toBe('<5s')
    expect(durationBucket(4_999)).toBe('<5s')
    expect(durationBucket(5_000)).toBe('5-15s')
    expect(durationBucket(14_999)).toBe('5-15s')
    expect(durationBucket(15_000)).toBe('15-30s')
    expect(durationBucket(30_000)).toBe('30-60s')
    expect(durationBucket(59_999)).toBe('30-60s')
    expect(durationBucket(60_000)).toBe('>60s')
    expect(durationBucket(Number.NaN)).toBe('<5s')
  })

  test('does not forward arbitrary exception metadata', () => {
    const privateError = new Error(
      'vacation.png (4032x3024) failed at blob:https://bg0.dev/private',
    )
    privateError.stack = [
      `Error: ${privateError.message}`,
      '    at removeVacation (https://bg0.dev/assets/remover-AbC123.js?private=1:42:7)',
      '    at vacation.png (https://images.example/vacation.png:1:1)',
    ].join('\n')
    const result = createReportableError(
      privateError,
      {
        area: 'background_removal',
        reason: 'inference-failed',
      },
      'https://bg0.dev',
    )

    expect(result.name).toBe('BG0Error')
    expect(result.message).toBe('Background removal failed: inference-failed')
    expect(result.stack).not.toContain('vacation.png')
    expect(result.stack).not.toContain('4032x3024')
    expect(result.stack).not.toContain('blob:')
    expect(result.stack).not.toContain('removeVacation')
    expect(result.stack).not.toContain('?private=1')
    expect(result.stack).toContain(
      'at https://bg0.dev/assets/remover-AbC123.js:42:7',
    )
  })
})
