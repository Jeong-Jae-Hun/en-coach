import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { isKorean, parseReply } from './register'

const REPLY = `1. Write tests for this function.
2. Add tests here.
---
- "짜줘"는 write보다 add가 자연스러울 때가 많습니다`

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const HISTORY = {
  component: 'Pane',
  requestId: 'en-coach-history',
  props: {
    title: '영어 추천 기록',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

test('한글 프롬프트만 번역 대상으로 본다', () => {
  expect(isKorean('이 함수 테스트 좀 짜줘')).toBe(true)
  expect(isKorean('write tests')).toBe(false)
  expect(isKorean('/en 테스트 짜줘')).toBe(false)
  expect(isKorean('짧음')).toBe(false)
})

test('응답을 추천 문장과 노트로 나눈다', () => {
  const s = parseReply('원문', REPLY)
  expect(s.options).toEqual(['Write tests for this function.', 'Add tests here.'])
  expect(s.notes).toHaveLength(1)
})

test('한글 프롬프트를 보내면 입력창 위에 영어 추천이 뜬다', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: REPLY, usage } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit({ text: '이 함수 테스트 좀 짜줘', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'en-coach', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Write tests for this function/ })).toBeDefined()
    await ui.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'en-coach', surface: 'desktop', ...HISTORY })
  expect(await pane.find({ type: 'Text', text: /이 함수 테스트 좀 짜줘/ })).toBeDefined()
  await pane.unmount()
})

test('영어 프롬프트를 보내면 지난 추천을 치운다', async ($, on) => {
  const clock = mock.clock(on)
  // 띠가 양보하면 아래(엔진 자리)의 기본 그림이 그려진다
  on('ui.render', ($, e) => h($.ui.resolve(e).Text, null, 'engine') as RenderElement)
  on('model.complete', () => ({ value: { isAnswered: true, text: REPLY, usage } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit({ text: '이 함수 테스트 좀 짜줘', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)
  await $.prompt.submit({ text: 'Write tests for this function.', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'en-coach', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Write tests for this function/ })).toBeUndefined()
  await ui.unmount()
})
