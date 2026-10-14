import type { PromptEditInput, PromptEditResult, RenderElement } from 'claude-code'
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { formatTokens, glossaryPrompt, isKorean, parseReply, parseTermArgs } from './register'

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

// 용어집 파일을 메모리로 흉내 낸다
const mockFs = (on: On, files: Map<string, string> = new Map()) => {
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  return files
}

const GLOSSARY_FILE = '/home/me/.claude/en-coach-glossary.json'

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

test('한글 프롬프트만 번역 대상으로 본다', () => {
  expect(isKorean('이 함수 테스트 좀 짜줘')).toBe(true)
  expect(isKorean('write tests')).toBe(false)
  expect(isKorean('/en 테스트 짜줘')).toBe(false)
  expect(isKorean('짧음')).toBe(false)
})

test('구분선이 없어도 팁 줄을 문장으로 착각하지 않는다', () => {
  const s = parseReply('원문', REPLY.replace('---\n', ''))
  expect(s.options).toEqual(['Write tests for this function.', 'Add tests here.'])
  expect(s.notes).toHaveLength(1)
})

test('토큰 수는 천 단위부터 k로 줄인다', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(3240)).toBe('3.2k')
})

test('응답을 추천 문장과 노트로 나눈다', () => {
  const s = parseReply('원문', REPLY)
  expect(s.options).toEqual(['Write tests for this function.', 'Add tests here.'])
  expect(s.notes).toHaveLength(1)
})

test('한글 프롬프트를 보내면 입력창 위에 영어 추천이 뜬다', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const files = mockFs(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: REPLY, usage } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit({ text: '이 함수 테스트 좀 짜줘', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'en-coach', surface, ...BAND })
    expect(await ui.find({ key: 'use-0' })).toBeDefined()
    await ui.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'en-coach', surface: 'desktop', ...HISTORY })
  expect(await pane.find({ type: 'Text', text: /이 함수 테스트 좀 짜줘/ })).toBeDefined()
  await pane.unmount()
})

test('영어 프롬프트를 보내면 지난 추천을 치운다', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const files = mockFs(on)
  // 띠가 양보하면 아래(엔진 자리)의 기본 그림이 그려진다
  on('ui.render', ($, e) => h($.ui.resolve(e).Text, null, 'engine') as RenderElement)
  on('model.complete', () => ({ value: { isAnswered: true, text: REPLY, usage } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit({ text: '이 함수 테스트 좀 짜줘', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)
  await $.prompt.submit({ text: 'Write tests for this function.', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'en-coach', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'use-0' })).toBeUndefined()
  await ui.unmount()
})

const KOREAN = '이 함수 테스트 좀 짜줘'
const typeKorean = {
  origin: { kind: 'composer' },
  text: '',
  cursor: 0,
  start: 0,
  end: 0,
  inputText: KOREAN,
} as const

// 엔진은 prompt.edit 를 올리지만 타입의 prompt 명사엔 edit 이 없다 — 사람이 치는 걸 흉내 내려고 연다
const typeInto = ($: unknown) =>
  ($ as { prompt: { edit: (e: PromptEditInput) => Promise<PromptEditResult> } }).prompt.edit(typeKorean)

test('타이핑을 멈추면 초를 세다가 자동 번역한다', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const files = mockFs(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: REPLY, usage } }))
  on('prompt.edit', ($, e) => ({ text: e.inputText, cursor: e.inputText.length }))

  await typeInto($)
  const ui = await $.ui.mount({ plugin: 'en-coach', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /3초 뒤 자동 번역/ })).toBeDefined()
  expect(await ui.find({ key: 'use-0' })).toBeUndefined()
  await ui.unmount()

  await clock.advance(3000)
  const after = await $.ui.mount({ plugin: 'en-coach', surface: 'desktop', ...BAND })
  expect(await after.find({ key: 'use-0' })).toBeDefined()
  await after.unmount()
})

test('번역 버튼을 누르면 기다리지 않고 바로 번역한다', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const files = mockFs(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: REPLY, usage } }))
  on('prompt.edit', ($, e) => ({ text: e.inputText, cursor: e.inputText.length }))

  await typeInto($)
  const ui = await $.ui.mount({ plugin: 'en-coach', surface: 'desktop', ...BAND })
  await ui.press({ key: 'translate' })
  expect(await ui.find({ key: 'use-0' })).toBeDefined()
  await ui.unmount()
})

const pressKey = ($: unknown, text: string, key: PromptEditInput['key']) =>
  ($ as { prompt: { edit: (e: PromptEditInput) => Promise<PromptEditResult> } }).prompt.edit({
    origin: { kind: 'composer' },
    key,
    text,
    cursor: text.length,
    start: text.length,
    end: text.length,
    inputText: key?.key ?? '',
  })

test('Ctrl/Option+숫자를 누르면 그 번호의 영어 문장으로 바꾼다', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const files = mockFs(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: REPLY, usage } }))
  on('prompt.edit', ($, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit({ text: KOREAN, wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)

  const plain = await pressKey($, KOREAN, { key: '2' })
  expect(plain.text).toBe(`${KOREAN}2`)

  const withOption = await pressKey($, KOREAN, { key: '2', meta: true })
  expect(withOption.text).toBe('Add tests here.')

  const withCtrl = await pressKey($, KOREAN, { key: '1', ctrl: true })
  expect(withCtrl.text).toBe('Write tests for this function.')
})

test('용어 명령을 목록·추가·삭제로 읽는다', () => {
  expect(parseTermArgs('')).toEqual({ kind: 'list' })
  expect(parseTermArgs('씨미=ci.me')).toEqual({ kind: 'add', from: '씨미', to: 'ci.me' })
  expect(parseTermArgs(' -씨미 ')).toEqual({ kind: 'remove', from: '씨미' })
})

test('문장에 나온 용어만 프롬프트에 싣는다', () => {
  const glossary = { 씨미: 'ci.me', 마플: 'Marpple' }
  const prompt = glossaryPrompt('씨미 배포해줘', glossary)
  expect(prompt).toContain('씨미 → ci.me')
  expect(prompt).not.toContain('Marpple')
  expect(glossaryPrompt('테스트 짜줘', glossary)).toBe('테스트 짜줘')
})

test('추가한 용어는 다음 번역 요청에 들어간다', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const files = mockFs(on)
  const sent: string[] = []
  on('model.complete', ($, e) => {
    sent.push(e.prompt)
    return { value: { isAnswered: true, text: REPLY, usage } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.command.run({ command: 'en-term', args: '씨미=ci.me' } as never)
  await $.prompt.submit({ text: '씨미 배포 좀 해줘', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)

  expect(sent[0]).toContain('씨미 → ci.me')
})

const REPLY_WITH_UNKNOWN = `${REPLY}
? 씨게더`

test('모르는 용어는 원문에 있는 것만 받는다', () => {
  const s = parseReply('씨게더 배포해줘', `${REPLY}\n? 씨게더\n? 없는말`)
  expect(s.unknown).toEqual(['씨게더'])
})

test('추가한 용어는 파일에 저장되고 경로는 EN_COACH_GLOSSARY 를 따른다', async ($, on) => {
  mock.store(on)
  mock.env(on, { HOME: '/home/me', EN_COACH_GLOSSARY: '~/.dotfiles/claude/glossary.json' })
  const files = mockFs(on)

  await $.command.run({ command: 'en-term', args: '씨미=ci.me' } as never)
  await $.command.run({ command: 'en-term', args: '마플=Marpple' } as never)

  expect(JSON.parse(files.get('/home/me/.dotfiles/claude/glossary.json') ?? '{}')).toEqual({
    마플: 'Marpple',
    씨미: 'ci.me',
  })
})

test('예전 store 용어집은 파일로 옮기고 지운다', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { glossary: { 씨미: 'ci.me' } })
  mock.env(on, { HOME: '/home/me' })
  const files = mockFs(on)
  const sent: string[] = []
  on('model.complete', ($, e) => {
    sent.push(e.prompt)
    return { value: { isAnswered: true, text: REPLY, usage } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit({ text: '씨미 배포 좀 해줘', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)

  expect(sent[0]).toContain('씨미 → ci.me')
  expect(JSON.parse(files.get(GLOSSARY_FILE) ?? '{}')).toEqual({ 씨미: 'ci.me' })
})

test('모르는 용어를 띠에서 등록하면 용어집에 넣고 다시 번역한다', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const files = mockFs(on)
  const sent: string[] = []
  on('model.complete', ($, e) => {
    sent.push(e.prompt)
    return { value: { isAnswered: true, text: sent.length === 1 ? REPLY_WITH_UNKNOWN : REPLY, usage } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit({ text: '씨게더 배포 좀 해줘', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'en-coach', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /모르는 용어/ })).toBeDefined()
  await ui.input({ key: 'term-씨게더', text: 'cigt' })
  await ui.unmount()

  expect(JSON.parse(files.get(GLOSSARY_FILE) ?? '{}')).toEqual({ 씨게더: 'cigt' })
  expect(sent).toHaveLength(2)
  expect(sent[1]).toContain('씨게더 → cigt')
})
