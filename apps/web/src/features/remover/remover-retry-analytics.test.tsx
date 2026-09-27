import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const imageSelectedCalls: string[] = []
const featureCalls: string[] = []
const interruptedCalls: [string, string][] = []
const failedCalls: string[] = []

mock.module('#/lib/analytics', () => ({
  capturePageView: () => {},
  captureImageSelected: (inputMethod: string) => {
    imageSelectedCalls.push(inputMethod)
  },
  captureRemovalSucceeded: () => {},
  showResultSurvey: () => {},
  captureRemovalFailed: (_inputMethod: string, reason: string) => {
    failedCalls.push(reason)
  },
  captureRemovalInterrupted: (stage: string, provider: string) => {
    interruptedCalls.push([stage, provider])
  },
  captureResultDownloaded: () => {},
  captureFeatureUsed: (feature: string) => {
    featureCalls.push(feature)
  },
  captureAppException: () => {},
}))

const { Remover } = await import('./remover')
const { BackgroundRemovalError } = await import('@bg0/browser')
const { cleanup, fireEvent, render, waitFor } = await import(
  '@testing-library/react'
)

import type {
  BackgroundRemovalResult,
  RemoveBackgroundOptions,
} from '@bg0/browser'

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register()
}

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

globalThis.IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver

afterEach(() => {
  cleanup()
  imageSelectedCalls.length = 0
  featureCalls.length = 0
  interruptedCalls.length = 0
  failedCalls.length = 0
  sessionStorage.clear()
})

afterAll(async () => {
  // React can still have a scheduled commit callback after the last cleanup.
  // Let it run before the DOM globals it reads are removed.
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister()
  }
})

function selectFile(view: ReturnType<typeof render>, file: File) {
  const transfer = new DataTransfer()
  transfer.items.add(file)
  fireEvent.change(
    view.getByLabelText('Choose an image file to remove its background'),
    { target: { files: transfer.files } },
  )
}

function resultWithSource(): BackgroundRemovalResult {
  return {
    blob: new Blob(['result'], { type: 'image/png' }),
    sourceBlob: new Blob(['source'], { type: 'image/png' }),
    width: 1,
    height: 1,
    provider: 'wasm',
    quality: 'quality',
    durationMs: 10,
    model: 'birefnet-lite',
  }
}

describe('Remover retry analytics', () => {
  test('a genuine selection emits once and retry does not emit again', async () => {
    let calls = 0
    const remove = mock(() => {
      calls += 1
      if (calls === 1) {
        return Promise.reject(
          new BackgroundRemovalError('inference-failed', 'transient boom'),
        )
      }
      return Promise.resolve(resultWithSource())
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={async () => {}}
      />,
    )

    try {
      selectFile(view, new File(['image'], 'retry.png', { type: 'image/png' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy()
      })
      expect(imageSelectedCalls).toEqual(['picker'])

      fireEvent.click(view.getByRole('button', { name: 'Try again' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(remove).toHaveBeenCalledTimes(2)
      expect(imageSelectedCalls).toEqual(['picker'])
    } finally {
      view.unmount()
    }
  })

  test('a new selection after reset emits again', async () => {
    const remove = mock(() => Promise.resolve(resultWithSource()))
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={async () => {}}
      />,
    )

    try {
      selectFile(view, new File(['one'], 'one.png', { type: 'image/png' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(imageSelectedCalls).toEqual(['picker'])

      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => {
        expect(
          view.getByText('Drop an image anywhere on this page'),
        ).toBeTruthy()
      })

      selectFile(view, new File(['two'], 'two.png', { type: 'image/png' }))
      await waitFor(() => {
        expect(remove).toHaveBeenCalledTimes(2)
      })
      expect(imageSelectedCalls).toEqual(['picker', 'picker'])
      // Start over already counted it; the next pick must not count again.
      expect(featureCalls).toEqual(['start_another_image'])
    } finally {
      view.unmount()
    }
  })

  test('drops and pastes on the result screen report their input method', async () => {
    const remove = mock(() => Promise.resolve(resultWithSource()))
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={async () => {}}
      />,
    )

    try {
      selectFile(view, new File(['one'], 'one.png', { type: 'image/png' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })

      const dropped = new DataTransfer()
      dropped.items.add(new File(['two'], 'two.png', { type: 'image/png' }))
      fireEvent.drop(window, { dataTransfer: dropped })
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })

      const pasted = new DataTransfer()
      pasted.items.add(new File(['three'], 'clip.png', { type: 'image/png' }))
      fireEvent.paste(window, { clipboardData: pasted })
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(3))
      expect(imageSelectedCalls).toEqual(['picker', 'drop', 'paste'])
      expect(featureCalls).toEqual([
        'start_another_image',
        'start_another_image',
      ])
    } finally {
      view.unmount()
    }
  })
})

describe('Remover interrupted runs', () => {
  const KEY = 'bg0:active-removal'
  const readMarker = () => {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  }

  test('a run records only stage, provider, time, and a random id, then clears on success', async () => {
    let finish!: (result: BackgroundRemovalResult) => void
    let report!: (
      stage: 'preparing' | 'processing',
      provider?: 'webgpu' | 'wasm',
    ) => void
    const remove = mock((_input: Blob, options?: RemoveBackgroundOptions) => {
      report = (stage, provider) =>
        options?.onProgress?.({
          stage,
          progress: 0.7,
          message: 'x',
          provider,
        })
      return new Promise<BackgroundRemovalResult>((resolve) => {
        finish = resolve
      })
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={async () => {}}
      />,
    )
    try {
      selectFile(
        view,
        new File(['a'], 'secret-name.png', { type: 'image/png' }),
      )
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
      report('preparing')
      // WebGPU may be available, but the provider is recorded only once chosen.
      expect(readMarker()).toMatchObject({
        stage: 'preparing',
        provider: 'unknown',
      })
      report('processing', 'wasm')
      const marker = readMarker()
      expect(Object.keys(marker ?? {}).sort()).toEqual([
        'id',
        'provider',
        'stage',
        'startedAt',
      ])
      expect(marker).toMatchObject({ stage: 'processing', provider: 'wasm' })
      expect(sessionStorage.getItem(KEY)).not.toContain('secret-name')
      finish(resultWithSource())
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(readMarker()).toBeNull()
    } finally {
      view.unmount()
    }
  })

  test.each(['failure', 'reset', 'unmount'] as const)(
    'the marker clears on %s',
    async (ending) => {
      let fail!: () => void
      const remove = mock(
        () =>
          new Promise<BackgroundRemovalResult>((_, reject) => {
            fail = () =>
              reject(new BackgroundRemovalError('inference-failed', 'boom'))
          }),
      )
      const view = render(
        <Remover
          removeBackgroundImpl={remove}
          waitForPaintImpl={async () => {}}
        />,
      )
      selectFile(view, new File(['a'], 'a.png', { type: 'image/png' }))
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
      expect(readMarker()).not.toBeNull()
      if (ending === 'failure') {
        fail()
        await waitFor(() =>
          expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy(),
        )
      } else if (ending === 'reset') {
        fireEvent.keyDown(window, { key: 'Escape' })
      }
      if (ending === 'unmount') view.unmount()
      expect(readMarker()).toBeNull()
      if (ending !== 'unmount') view.unmount()
      expect(interruptedCalls).toEqual([])
    },
  )

  test('a page that died mid-run reports it once and explains it', async () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        stage: 'processing',
        provider: 'wasm',
        startedAt: Date.now() - 20_000,
      }),
    )
    const view = render(<Remover waitForPaintImpl={async () => {}} />)
    try {
      await waitFor(() =>
        expect(interruptedCalls).toEqual([['processing', 'wasm']]),
      )
      expect(view.getByRole('status').textContent).toContain(
        'the browser ran out of memory',
      )
      expect(readMarker()).toBeNull()
    } finally {
      view.unmount()
    }
    const again = render(<Remover waitForPaintImpl={async () => {}} />)
    again.unmount()
    expect(interruptedCalls).toHaveLength(1)
  })

  test('a run still holding its lock in another tab is not reported', async () => {
    const raw = JSON.stringify({
      stage: 'processing',
      provider: 'wasm',
      startedAt: Date.now() - 20_000,
      id: 'other-tab',
    })
    let held = ['bg0:active-removal:other-tab']
    let queries = 0
    const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: () => Promise.resolve(),
        query: async () => {
          queries++
          return {
            held: held.map((name) => ({ name, mode: 'exclusive' })),
            pending: [],
          }
        },
      },
    })
    try {
      // This tab was duplicated while the other one was still processing.
      sessionStorage.setItem(KEY, raw)
      const view = render(<Remover waitForPaintImpl={async () => {}} />)
      await waitFor(() => expect(queries).toBe(1))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(interruptedCalls).toEqual([])
      expect(view.queryByText(/ran out of memory/)).toBeNull()
      expect(sessionStorage.getItem(KEY)).toBe(raw)
      view.unmount()

      // Once that tab dies, its lock is gone and the marker is reported.
      held = []
      const again = render(<Remover waitForPaintImpl={async () => {}} />)
      await waitFor(() =>
        expect(interruptedCalls).toEqual([['processing', 'wasm']]),
      )
      expect(again.getByRole('status').textContent).toContain(
        'the browser ran out of memory',
      )
      expect(readMarker()).toBeNull()
      again.unmount()
    } finally {
      if (original) Object.defineProperty(navigator, 'locks', original)
      else delete (navigator as { locks?: unknown }).locks
    }
  })

  test('an old marker from an earlier visit is dropped silently', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        stage: 'processing',
        provider: 'wasm',
        startedAt: Date.now() - 60 * 60_000,
      }),
    )
    const view = render(<Remover waitForPaintImpl={async () => {}} />)
    expect(interruptedCalls).toEqual([])
    expect(view.queryByText(/ran out of memory/)).toBeNull()
    expect(readMarker()).toBeNull()
    view.unmount()
  })

  test('a run that stops reporting progress becomes a retryable error', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const remove = mock((_input: Blob, options?: RemoveBackgroundOptions) => {
      signals.push(options?.signal)
      return signals.length === 1
        ? new Promise<BackgroundRemovalResult>(() => {})
        : Promise.resolve(resultWithSource())
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={async () => {}}
        stallTimeoutMs={30}
      />,
    )
    try {
      selectFile(view, new File(['a'], 'a.png', { type: 'image/png' }))
      await waitFor(() =>
        expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy(),
      )
      expect(view.getAllByText(/stopped responding/).length).toBeGreaterThan(0)
      expect(failedCalls).toEqual(['inference-failed'])
      expect(readMarker()).toBeNull()
      // The stalled run is aborted so the browser package can free its slot.
      expect(signals[0]?.aborted).toBe(true)
      fireEvent.click(view.getByRole('button', { name: 'Try again' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(remove).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
    }
  })
})
