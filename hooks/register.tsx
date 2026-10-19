import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, UiPressArgument } from 'claude-code'

import type { Suggestion } from '../types'

const AUTO_SECONDS = 3
// 가장 싼 모델($0.10/$0.50 per MTok). 구형 Haiku 4.5가 10배 비싸 별칭 대신 ID로 고정한다
const MODEL = 'claude-haiku-5-5'
const HISTORY_LIMIT = 50
const PANE = 'en-coach-history'
const HISTORY_PANE = { id: PANE, title: '영어 추천 기록', closeOnEscape: true } as const
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
Then, for each proper noun, product or internal name, or slang whose English form you are not sure of and that the glossary does not cover, add one line: ? <the Korean term as written>
If the prompt spans several lines, translate every line and keep the line breaks inside each numbered item; write any list in it with "-" bullets, not numbers.
Keep code identifiers, file paths, commands and English terms unchanged.`

// 넣기로 넣은 추천 뒤에 한글을 이어 쓰면 앞의 영어 문장은 그대로 두고 한글이 시작된 문장부터 번역한다.
// 경계는 줄바꿈이나 문장부호+공백이다. 한계: 'e.g. ' 같은 약어도 경계로 본다
export const splitEnglishHead = (text: string) => {
  const first = text.search(/[가-힣]/)
  if (first <= 0) {
    return { head: '', rest: text }
  }
  const before = text.slice(0, first)
  const cut = Math.max(
    before.lastIndexOf('\n') + 1,
    ...[...before.matchAll(/[.!?]\s+/g)].map(m => m.index + m[0].length),
  )

  return { head: text.slice(0, cut), rest: text.slice(cut) }
}

export const isKorean = (text: string) =>
  !text.trimStart().startsWith('/') &&
  /[가-힣]/.test(text) &&
  splitEnglishHead(text).rest.trim().length >= MIN_LENGTH

// 여러 줄 프롬프트는 번호 줄 아래로 문장이 이어진다 — 다음 번호 줄 전까지 앞 문장에 붙인다.
// 구분선(---)을 빼먹는 응답이 있어, 그때는 글머리표·모르는 용어 줄에서 문장을 끊는다
export const parseReply = (source: string, reply: string): Suggestion => {
  const lines = reply.split('\n').map(line => line.trim())
  const sep = lines.indexOf('---')
  const tail = sep === -1 ? lines : lines.slice(sep + 1)
  const options: string[] = []
  for (const line of sep === -1 ? lines : lines.slice(0, sep)) {
    if (/^\d+[.)]\s+/.test(line)) {
      options.push(line.replace(/^\d+[.)]\s+/, ''))
    } else if (sep === -1 && /^([-*·•]|\?)\s+/.test(line)) {
      break
    } else if (options.length > 0) {
      options[options.length - 1] += `\n${line}`
    }
  }
  const notes = tail
    .filter(line => /^[-*·•]\s+/.test(line))
    .map(line => line.replace(/^[-*·•]\s+/, ''))
  const unknown = tail
    .filter(line => /^\?\s+/.test(line))
    .map(line => line.replace(/^\?\s+/, ''))
    .filter(term => term.length > 0 && source.includes(term))

  return { source, options: options.slice(0, 2).map(option => option.trim()), notes, unknown }
}

const copyText = async ($: EngineInterface, text: string, surface: UiPressArgument['surface']) => {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? '복사했습니다' : '이 화면에선 복사할 수 없습니다')
}

// ─── 숫자 키 ───
// 맥 영문 자판에서 Option+1·2·3 은 수정키 없이 ¡ ™ £ 로 들어온다(한글 자판은 meta 가 붙은 숫자).
// 그래서 두 모양을 다 받는다. 한계: 이 세 글자를 일부러 칠 수는 없게 된다
const OPTION_DIGITS: Record<string, number> = { '¡': 1, '™': 2, '£': 3 }

export const pickedNumber = (key: { key: string; ctrl?: true; meta?: true } | undefined, inputText: string) => {
  if (key === undefined) {
    return NaN
  }
  if (key.ctrl || key.meta) {
    return Number(key.key)
  }

  return OPTION_DIGITS[inputText] ?? NaN
}

// ─── 용어집 ───
// 파일로 둬서 dotfiles 처럼 git 으로 머신 간 동기화할 수 있게 한다.
// EN_COACH_GLOSSARY 로 경로를 바꾼다(앞의 ~ 는 HOME). 없으면 ~/.claude/en-coach-glossary.json
const LEGACY_STORE_KEY = 'glossary'

type Glossary = Record<string, string>

export type TermCommand =
  | { kind: 'list' }
  | { kind: 'add'; from: string; to: string }
  | { kind: 'remove'; from: string }

export const parseTermArgs = (args: string): TermCommand => {
  const text = args.trim()
  if (text === '') {
    return { kind: 'list' }
  }
  if (text.startsWith('-')) {
    return { kind: 'remove', from: text.slice(1).trim() }
  }
  const [from = '', ...rest] = text.split('=')
  const to = rest.join('=').trim()

  return to === '' ? { kind: 'list' } : { kind: 'add', from: from.trim(), to }
}

// 문장에 나온 용어만 보낸다 — 용어집이 커져도 호출마다 전부 싣지 않게
export const glossaryPrompt = (text: string, glossary: Glossary) => {
  const used = Object.entries(glossary).filter(([from]) => text.includes(from))
  if (used.length === 0) {
    return text
  }

  return `Glossary (always use exactly these English forms):\n${used
    .map(([from, to]) => `${from} → ${to}`)
    .join('\n')}\n\nKorean prompt:\n${text}`
}

const glossaryPath = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME')) ?? ''
  const raw = (await $.env.get('EN_COACH_GLOSSARY')) ?? '~/.claude/en-coach-glossary.json'

  return raw.replace(/^~(?=\/)/, home)
}

export const sortGlossary = (glossary: Glossary): Glossary =>
  Object.fromEntries(Object.entries(glossary).sort(([a], [b]) => a.localeCompare(b, 'ko')))

const writeGlossary = async ($: EngineInterface, glossary: Glossary) =>
  $.fs.write(await glossaryPath($), `${JSON.stringify(sortGlossary(glossary), null, 2)}\n`)

// 예전 버전이 $.store 에 넣어 둔 용어는 파일로 합친 뒤 지운다 — 등록한 용어를 잃지 않게
const readGlossary = async ($: EngineInterface): Promise<Glossary> => {
  const path = await glossaryPath($)
  const fromFile = (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as Glossary) : {}
  const legacy = (await $.store.get(LEGACY_STORE_KEY)) as Glossary | undefined
  if (legacy === undefined) {
    return fromFile
  }
  const merged = { ...legacy, ...fromFile }
  await writeGlossary($, merged)
  await $.store.delete(LEGACY_STORE_KEY)

  return merged
}

const addTerm = async ($: EngineInterface, from: string, to: string) =>
  writeGlossary($, { ...(await readGlossary($)), [from]: to })

export const formatTokens = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`)

// 새 번역이 시작되면 이전 요청은 끊는다
let stop = new AbortController()

const suggest = async ($: EngineInterface, text: string, force = false) => {
  const current = await read($, suggestion)
  if (!force && current?.source === text) {
    return
  }

  stop.abort()
  const mine = new AbortController()
  stop = mine
  await update($, isBusy, () => true)
  const { head, rest } = splitEnglishHead(text)
  try {
    const r = await $.model.complete(
      { model: MODEL, system: SYSTEM, prompt: glossaryPrompt(rest, await readGlossary($)), effort: 'low', maxTokens: 800, timeoutMs: 15000 },
      { signal: mine.signal },
    )
    // 끊긴 요청도 비용은 든다 — 응답 여부와 상관없이 센다
    await update($, usage, u => ({
      calls: u.calls + 1,
      input: u.input + r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0),
      output: u.output + r.usage.output_tokens,
    }))
    if (r.isAnswered && stop === mine) {
      const reply = parseReply(text, r.text)
      const next = { ...reply, options: reply.options.map(option => head + option) }
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

// 띠에서 바로 등록한 용어로 같은 문장을 다시 번역한다
const saveTerm = async ($: EngineInterface, term: string, english: string, source: string) => {
  const to = english.trim()
  if (to === '') {
    return
  }
  await addTerm($, term, to)
  await suggest($, source, true)
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
    await $.command.register({
      name: 'en-history',
      description: '영어 추천 기록 패널 열기/닫기',
    })
    await $.command.register({
      name: 'en-term',
      description: '영어 추천 용어집: 목록 / 한글=영어 추가 / -한글 삭제',
      argumentHint: '[씨미=ci.me | -씨미]',
    })

    return next(e)
  })

  on('command.run', { command: 'en-term' }, async ($, e) => {
    const cmd = parseTermArgs(e.args)
    const glossary = await readGlossary($)
    if (cmd.kind === 'add') {
      await addTerm($, cmd.from, cmd.to)
      return { text: `용어 추가: ${cmd.from} → ${cmd.to}` }
    }
    if (cmd.kind === 'remove') {
      const { [cmd.from]: removed, ...rest } = glossary
      await writeGlossary($, rest)
      return { text: removed === undefined ? `없는 용어: ${cmd.from}` : `용어 삭제: ${cmd.from}` }
    }
    const lines = Object.entries(glossary).map(([from, to]) => `- ${from} → ${to}`)

    return {
      text: lines.length === 0 ? '용어집이 비었습니다. `/en-term 씨미=ci.me` 처럼 추가하세요.' : `용어집\n${lines.join('\n')}`,
    }
  })

  on('command.run', { command: 'en' }, async $ => {
    await update($, isHidden, was => !was)
    const hidden = await read($, isHidden)

    return { text: hidden ? '영어 추천을 껐습니다.' : '영어 추천을 켰습니다.' }
  })

  // 터미널에선 띠의 버튼이 Ctrl+X Tab 으로 초점을 줘야 눌려서, 명령으로도 여닫게 한다
  on('command.run', { command: 'en-history' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: '기록 패널을 닫았습니다.' }
    }
    await $.ui.open(HISTORY_PANE)

    return { text: '기록 패널을 열었습니다.' }
  })

  // 키 입력마다 카운트다운을 처음부터 다시 센다 — 타이핑 중엔 Haiku를 부르지 않게
  // 입력창에 글이 있을 땐 숫자가 그대로 입력돼야 하니 Option+숫자만 가로챈다.
  // prompt.edit 은 글자를 넣는 키에만 온다: Ctrl+숫자는 아무것도 넣지 않아 데스크톱 앱에선 오지 않는다.
  // 그래도 Ctrl+숫자를 편집으로 보내는 터미널(kitty 키 프로토콜 등)을 위해 ctrl 도 받아 둔다
  // 입력창이 비었을 땐 띠의 버튼 hotkey 가 맨 숫자를 받는다 (엔진 규칙)
  on('prompt.edit', async ($, e, next) => {
    const picked = pickedNumber(e.key, e.inputText)
    if (picked === 3) {
      const d = await read($, draft)
      if (d !== null) {
        void translateNow($, d.text)
        return { text: e.text, cursor: e.cursor }
      }
    }
    const option = (await read($, suggestion))?.options[picked - 1]
    if (option !== undefined) {
      return { text: option, cursor: option.length }
    }

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

  // 엔터를 쳤으면 그 문장은 끝났다 — 카운트다운·진행 중 번역을 멈추고 띠를 치운다.
  // 컨트롤러를 갈아 끼워, 끊겼는데도 답이 와 버린 요청이 띠를 다시 채우지 못하게 한다
  on('prompt.submit', async ($, e, next) => {
    await cancelDraft($)
    stop.abort()
    stop = new AbortController()
    await update($, isBusy, () => false)
    await update($, suggestion, () => null)

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

    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // 입력칸이 없는 화면(모바일 등)에선 명령어 안내로 대신한다
    const Input = 'Input' in table ? table.Input : undefined
    // 터미널은 왼쪽 Option 을 Alt(meta) 로 보내 글자가 안 들어온다 — 오른쪽 Option 만 글자를 넣게 설정해 둔다
    const opt = e.surface === 'terminal' ? '오른쪽 ⌥' : '⌥'

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          {d !== null ? (
            <Box>
              <Button key="translate" label="번역" hotkey="3" onPress={() => translateNow($, d.text)} />
              <Text dimColor> {d.secondsLeft}초 뒤 자동 번역 · {opt}3 바로 번역</Text>
            </Box>
          ) : (
            <Text dimColor>{busy ? '번역 중…' : `English · ${opt}+숫자로 넣기 · /en-history 기록`}</Text>
          )}
          <Box gap={1}>
            <Button key="history" label="기록" onPress={() => $.ui.open(HISTORY_PANE)} />
            {s !== null && <Button key="clear" label="닫기" onPress={() => update($, suggestion, () => null)} />}
          </Box>
        </Box>
        {/* 문장은 Text 로 그려 끝까지 줄바꿈되게 한다(데스크톱 버튼은 한 줄로 잘린다). 번호는 같은 Text 안이라 첫 줄에 붙는다 */}
        {s?.options.map((option, i) => (
          <Text wrap="wrap">
            <Text color="suggestion">{i + 1} </Text>
            {option}
          </Text>
        ))}
        {s !== null && s.options.length > 0 && (
          <Box gap={1}>
            {s.options.map((option, i) => (
              <Button key={`use-${i}`} hotkey={`${i + 1}`} label={`${i + 1}번 넣기`} onPress={() => $.prompt.fill({ text: option, mode: 'replace' })} />
            ))}
          </Box>
        )}
        {s?.notes.map(note => (
          <Text dimColor>· {note}</Text>
        ))}
        {s !== null && s.unknown.length > 0 && (
          <Box flexDirection="column">
            <Text color="warning">모르는 용어가 있어요. 영어 표기를 적어 용어집에 추가하면 다시 번역합니다.</Text>
            {s.unknown.map(term =>
              Input ? (
                <Input
                  key={`term-${term}`}
                  label={term}
                  placeholder="영어 표기"
                  submitLabel="추가"
                  onSubmit={(value: string) => void saveTerm($, term, value, s.source)}
                />
              ) : (
                <Text dimColor>/en-term {term}=영어표기</Text>
              ),
            )}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, history)
    const u = await read($, usage)

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text bold>기록 {list.length}개</Text>
          <Box gap={1}>
            <Text dimColor>
              Haiku {u.calls}회 · 입력 {formatTokens(u.input)} · 출력 {formatTokens(u.output)}
            </Text>
            <Button key="close-history" label="닫기" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>
        {list.length === 0 && <Text dimColor>한글로 프롬프트를 쓰면 여기에 쌓입니다.</Text>}
        {list.map((one, n) => (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor>{one.source}</Text>
            <Box flexDirection="column" marginTop={1}>
              {one.options.map((option, i) => (
                <Box>
                  <Text color="suggestion">{i + 1} </Text>
                  <Text bold={i === 0}>{option}</Text>
                </Box>
              ))}
            </Box>
            {one.notes.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {one.notes.map(note => (
                  <Text color="subtle">팁 · {note}</Text>
                ))}
              </Box>
            )}
            {/* 패널 글자는 선택이 안 되는 화면이 있어 복사 버튼을 따로 둔다 */}
            <Box gap={1} marginTop={1}>
              {one.options.map((option, i) => (
                <Button key={`copy-${n}-${i}`} dimColor label={`${i + 1} 복사`} onPress={press => void copyText($, option, press.surface)} />
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
