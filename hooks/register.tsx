import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Suggestion } from '../types'

const AUTO_SECONDS = 3
const HISTORY_LIMIT = 50
const PANE = 'en-coach-history'
const MIN_LENGTH = 6

const suggestion = atom({ plugin: 'en-coach', key: 'suggestion' } as const, null)
const isBusy = atom({ plugin: 'en-coach', key: 'isBusy' } as const, false)
const isHidden = atom({ plugin: 'en-coach', key: 'isHidden' } as const, false)
const history = atom({ plugin: 'en-coach', key: 'history' } as const, [])
const draft = atom({ plugin: 'en-coach', key: 'draft' } as const, null)
const usage = atom({ plugin: 'en-coach', key: 'usage' } as const, { calls: 0, input: 0, output: 0 })

const SYSTEM = `You help a Korean developer learn to write prompts for an AI coding agent in English.
Given a Korean prompt, reply in exactly this format and nothing else:
1. <natural English rewrite, as a fluent developer would type it>
2. <a shorter, more casual alternative>
---
- <tip in Korean on one key expression, e.g. "보기가 불편하다 → hard to read">
- <optional second tip in Korean>
Write the tips in Korean, never English.
Keep code identifiers, file paths, commands and English terms unchanged.`

export const isKorean = (text: string) =>
  text.trim().length >= MIN_LENGTH && !text.trimStart().startsWith('/') && /[가-힣]/.test(text)

export const parseReply = (source: string, reply: string): Suggestion => {
  const [head = '', tail = ''] = reply.split(/^---\s*$/m)
  const options = head
    .split('\n')
    .map(line => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(line => line.length > 0)
  const notes = tail
    .split('\n')
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(line => line.length > 0)

  return { source, options, notes }
}

// 새 번역이 시작되면 이전 요청은 끊는다
let stop = new AbortController()

const suggest = async ($: EngineInterface, text: string) => {
  const current = await read($, suggestion)
  if (current?.source === text) {
    return
  }

  stop.abort()
  const mine = new AbortController()
  stop = mine
  await update($, isBusy, () => true)
  try {
    const r = await $.model.complete(
      { model: 'haiku', system: SYSTEM, prompt: text, effort: 'low', maxTokens: 400, timeoutMs: 15000 },
      { signal: mine.signal },
    )
    // 끊긴 요청도 비용은 든다 — 응답 여부와 상관없이 센다
    await update($, usage, u => ({
      calls: u.calls + 1,
      input: u.input + r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0),
      output: u.output + r.usage.output_tokens,
    }))
    if (r.isAnswered && stop === mine) {
      const next = parseReply(text, r.text)
      await update($, suggestion, () => next)
      await update($, history, list =>
        [next, ...list.filter(one => one.source !== text)].slice(0, HISTORY_LIMIT),
      )
    }
    if (!r.isAnswered && r.reason !== 'aborted') {
      $.ui.toast(`en-coach: ${r.reason}`)
    }
  } finally {
    // 끊긴 이전 요청이 새 요청의 '번역 중' 표시를 지우거나 남기지 않게, 마지막 요청만 끈다
    if (stop === mine) {
      await update($, isBusy, () => false)
    }
  }
}

// 타이핑이 멈추면 초를 세다가 0이 되면 번역한다 — 버튼으로 바로 당길 수 있다
let tick: Timer | undefined

const cancelDraft = async ($: EngineInterface) => {
  tick?.cancel()
  tick = undefined
  await update($, draft, () => null)
}

const translateNow = async ($: EngineInterface, text: string) => {
  await cancelDraft($)
  await suggest($, text)
}

const countDown = async ($: EngineInterface) => {
  const d = await read($, draft)
  if (d === null) {
    return
  }
  if (d.secondsLeft <= 1) {
    await translateNow($, d.text)
    return
  }
  await update($, draft, () => ({ ...d, secondsLeft: d.secondsLeft - 1 }))
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'en',
      description: '영어 프롬프트 추천 켜기/끄기',
    })

    return next(e)
  })

  on('command.run', { command: 'en' }, async $ => {
    await update($, isHidden, was => !was)
    const hidden = await read($, isHidden)

    return { text: hidden ? '영어 추천을 껐습니다.' : '영어 추천을 켰습니다.' }
  })

  // 키 입력마다 카운트다운을 처음부터 다시 센다 — 타이핑 중엔 Haiku를 부르지 않게
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    tick?.cancel()
    if (isKorean(box.text) && (await read($, suggestion))?.source !== box.text) {
      await update($, draft, () => ({ text: box.text, secondsLeft: AUTO_SECONDS }))
      tick = $.clock.every(1000, () => void countDown($))
    } else {
      await cancelDraft($)
    }

    return box
  })

  // 붙여넣고 바로 보내거나 edit 이벤트가 없는 화면(데스크톱 앱 등)에서도 추천이 뜨게
  // 보낸 프롬프트가 한글이면 그 문장의 추천으로 바꾸고, 아니면 지난 추천을 치운다
  on('prompt.submit', async ($, e, next) => {
    await cancelDraft($)
    if (isKorean(e.text)) {
      $.clock.after(0, () => void suggest($, e.text))
    } else {
      stop.abort()
      await update($, suggestion, () => null)
    }

    return next(e)
  })

  // 오른쪽 패널 대신 입력창 바로 위 띠에 띄운다
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, suggestion)
    const busy = await read($, isBusy)
    const d = await read($, draft)
    if (e.props.hasSurvey || (await read($, isHidden)) || (s === null && !busy && d === null)) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          {d !== null ? (
            <Box>
              <Button key="translate" label="번역" onPress={() => translateNow($, d.text)} />
              <Text dimColor> {d.secondsLeft}초 뒤 자동 번역</Text>
            </Box>
          ) : (
            <Text dimColor>{busy ? '번역 중…' : 'English'}</Text>
          )}
          <Box gap={1}>
            <Button key="history" label="기록" onPress={() => $.ui.open({ id: PANE, title: '영어 추천 기록' })} />
            {s !== null && <Button key="clear" label="닫기" onPress={() => update($, suggestion, () => null)} />}
          </Box>
        </Box>
        {s?.options.map((option, i) => (
          <Box>
            <Button key={`use-${i}`} label="넣기" onPress={() => $.prompt.fill({ text: option, mode: 'replace' })} />
            <Text> {option}</Text>
          </Box>
        ))}
        {s?.notes.map(note => (
          <Text dimColor>· {note}</Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, history)
    const u = await read($, usage)

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          이 세션 Haiku 호출 {u.calls}회 · 입력 {u.input} · 출력 {u.output} 토큰
        </Text>
        {list.length === 0 && <Text dimColor>아직 기록이 없습니다.</Text>}
        {list.map(one => (
          <Box flexDirection="column">
            <Text dimColor>{one.source}</Text>
            {one.options.map(option => (
              <Text>→ {option}</Text>
            ))}
            {one.notes.map(note => (
              <Text dimColor>· {note}</Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
