import { createFileRoute } from '@tanstack/react-router'

import { LegalPage } from '#/components/legal-page'
import { GITHUB_URL } from '#/lib/site'

export const Route = createFileRoute('/privacy')({
  head: () => ({
    meta: [
      { title: 'Privacy — BG0' },
      {
        name: 'description',
        content:
          'What BG0 does with your images and data. Short answer: your images never leave your device.',
      },
    ],
    links: [{ rel: 'canonical', href: 'https://bg0.dev/privacy' }],
  }),
  component: Privacy,
})

function Privacy() {
  return (
    <LegalPage title="Privacy" updated="September 25, 2026">
      <p>
        BG0 removes image backgrounds on your own device. This page explains
        exactly what leaves your browser when you use bg0.dev, which is very
        little.
      </p>
      <h2>Your images</h2>
      <p>
        Images you drop, paste, or open are read into your browser's memory,
        processed by a model running on your device, and turned into a PNG in
        the same place.{' '}
        <strong>Image bytes are never uploaded to us or to anyone else.</strong>{' '}
        We do not receive pixels, thumbnails, masks, file names, file sizes, or
        image URLs. Close the tab and the image is gone.
      </p>
      <h2>What the site loads</h2>
      <ul>
        <li>The web app itself, served from bg0.dev.</li>
        <li>
          The model weights, downloaded once from the Hugging Face model hub and
          cached in your browser. Hugging Face sees an ordinary file download
          from your IP address, nothing about your images.
        </li>
      </ul>
      <h2>Cookies and tracking</h2>
      <p>
        bg0.dev uses PostHog for anonymous, first-party product and web
        analytics. We record page routes and a small set of actions: choosing an
        image, whether local removal succeeded, the browser engine used, roughly
        how long removal took (such as "5-15s"), downloading or copying a
        result, and using result views. We never send image contents or image
        metadata to PostHog. Session recording, advertising, fingerprinting, and
        automatic click capture are disabled.
      </p>
      <p>
        We also use PostHog to collect survey answers you choose to submit and
        to report app errors. Surveys are multiple choice, plus one optional
        short text answer that only appears after you rate a result poorly.
        Before that text is sent, your browser shortens it to 500 characters and
        replaces email addresses, links, image filenames and sizes, and long
        numbers such as phone numbers.
        Please don't include personal details. One question asks what kind of
        image you used, such as a product or a pet. That is the category you
        pick; we never work it out from the image. Error reports include a
        controlled error category and safe application code locations, without
        the original error text, image URLs, image contents, or image metadata.
        Survey responses and error reports use the same anonymous identifier as
        the analytics above.
      </p>
      <p>
        PostHog stores a random anonymous identifier in local storage so visits
        can be counted without an account. The model cache also uses browser
        storage and only holds model files.
      </p>
      <h2>Changes</h2>
      <p>
        If this policy changes, the date at the top of this page changes with
        it. The full history is in the public repository on{' '}
        <a href={GITHUB_URL}>GitHub</a>.
      </p>
    </LegalPage>
  )
}
