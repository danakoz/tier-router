// Which Claude tier a request needs: tev1's answers to four questions and a
// few keyword signals, folded into one difficulty score and cut by two fitted
// thresholds. The same computation as tier_router/classify.py, which the
// evaluation in eval/ runs; the data both use is generated into model.ts.

import { NEGATIVE, POSITIVE, QUESTIONS, QUICK, SIGNALS, WEIGHTS } from './model.ts'

export type Tier = 'haiku' | 'sonnet' | 'opus'

export type Answers = {
  tier: { probabilities: Record<string, number> }
  simple: { noul: number }
  deep: { noul: number }
  effort: { score: number }
}

export type Features = Record<string, number>

export function trim(text: string, limit: number): string {
  const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (clean.length <= limit) return clean
  const head = Math.floor((limit * 2) / 3)
  return `${clean.slice(0, head)} … ${clean.slice(clean.length - (limit - head - 3))}`
}

/** What tev1 is shown: its context is about 2,000 tokens. */
export function stateFor(prompt: string, context = ''): string {
  const parts: string[] = []
  if (context) parts.push(`End of the assistant's previous reply:\n${trim(context, 700)}`)
  parts.push(`The user's new request:\n${trim(prompt, 1800)}`)
  return parts.join('\n\n')
}

/** The body of a POST to /v1/systemone: Ollama's (tev1) or TypeSafe's (Jev),
 * which take the same questions. `keep_alive` is Ollama's alone. */
export function request(model: string, prompt: string, context = '', local = true): string {
  const body = { model, state: stateFor(prompt, context), questions: QUESTIONS }
  return JSON.stringify(local ? { ...body, keep_alive: '30m' } : body)
}

function count(rx: RegExp, text: string): number {
  rx.lastIndex = 0
  return text.match(rx)?.length ?? 0
}

export function features(prompt: string, a: Answers): Features {
  const t = a.tier.probabilities
  const text = trim(prompt, 4000)
  const levels = QUESTIONS.effort.criteria.length - 1
  const f: Features = {
    tier: (t.sonnet ?? 0) * 0.5 + (t.opus ?? 0),
    simple: a.simple.noul,
    deep: a.deep.noul,
    effort: (a.effort.score ?? 0) / levels,
    long: Math.min(text.length / 1500, 1),
  }
  let harder = false
  for (const [name, rx] of Object.entries(SIGNALS)) {
    f[name] = Math.min(count(rx, text), 2) / 2
    harder ||= f[name] > 0
  }
  f.quick = QUICK.test(text) && text.length < 80 && !harder ? 1 : 0
  return f
}

const get = (r: Record<string, number>, k: string) => r[k] ?? 0

/** Difficulty in [0, 1]. */
export function score(f: Features, w: Record<string, number> = WEIGHTS): number {
  const sum = (names: readonly string[], g: (n: string) => number) =>
    names.reduce((s, n) => s + g(n), 0)
  const pos = sum(POSITIVE, n => get(w, `w_${n}`) * get(f, n))
  const neg = sum(NEGATIVE, n => get(w, `w_${n}`) * get(f, n))
  const hi = sum(POSITIVE, n => get(w, `w_${n}`))
  const lo = -sum(NEGATIVE, n => get(w, `w_${n}`))
  return hi > lo ? (pos - neg - lo) / (hi - lo) : 0.5
}

export function tierFor(s: number, w: Record<string, number> = WEIGHTS): Tier {
  if (s >= get(w, 't_opus')) return 'opus'
  if (s >= get(w, 't_sonnet')) return 'sonnet'
  return 'haiku'
}

/** How close a score is to either threshold. */
export function edge(s: number, w: Record<string, number> = WEIGHTS): number {
  return Math.min(Math.abs(s - get(w, 't_sonnet')), Math.abs(s - get(w, 't_opus')))
}
