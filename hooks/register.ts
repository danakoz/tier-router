// tev1-router: before each prompt's turn, ask tev1 (a local decision model in
// Ollama) which of Haiku, Sonnet or Opus the prompt needs, and send every
// model request of that turn to it.
//
// - The decision is made once per turn, at `turn.start`, and every step of the
//   turn (its tool-result follow-ups) uses it: a turn never changes model
//   halfway, so its prompt cache holds.
// - A score close to a threshold keeps the session's current tier: switching
//   model starts the prompt cache over.
// - Subagents keep the model they were given.
// - If tev1 is unreachable or slow, the turn keeps the session's model.

import type { EngineInterface as Engine, Register } from 'claude-code'

import { edge, features, request, score, tierFor, type Answers, type Tier } from './classify.ts'

const HYSTERESIS = 0.03
const TIMEOUT_MS = 8000

type Decision = { tier: Tier; score: number; ms: number; prompt: string; kept?: boolean }
type Config = { ollama: string; tev1: string }

async function giveUp($: Engine, ms: number): Promise<never> {
  await $.clock.sleep(ms)
  throw new Error(`no answer in ${ms / 1000} s`)
}

/** tev1's tier for a prompt, or why there is none. */
async function decide($: Engine, cfg: Config, prompt: string, context: string, current: Tier | undefined): Promise<Decision | string> {
  const started = await $.clock.now()
  try {
    const res = await Promise.race([
      $.http.fetch(`${cfg.ollama}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: request(cfg.tev1, prompt, context),
      }),
      giveUp($, TIMEOUT_MS),
    ])
    if (!res.ok) return `tev1 answered HTTP ${res.status}`
    const answers = JSON.parse(res.text).answers as Answers
    const s = score(features(prompt, answers))
    let tier = tierFor(s)
    let kept = false
    if (current && tier !== current && edge(s) < HYSTERESIS) {
      tier = current
      kept = true
    }
    return { tier, score: s, ms: (await $.clock.now()) - started, prompt: prompt.slice(0, 80), kept }
  } catch (err) {
    return `tev1 unreachable (${err instanceof Error ? err.message : String(err)})`
  }
}

export const register: Register = (on, options) => {
  const models: Record<Tier, string> = {
    haiku: String(options.haikuModel ?? 'claude-haiku-5-5'),
    sonnet: String(options.sonnetModel ?? 'claude-sonnet-5-5'),
    opus: String(options.opusModel ?? 'claude-opus-5-5'),
  }
  const cfg: Config = {
    ollama: String(options.ollamaUrl ?? 'http://localhost:11434').replace(/\/+$/, ''),
    tev1: String(options.tev1Model ?? 'tev1'),
  }

  const turns = new Map<string, Promise<Decision | string>>()
  const recent: (Decision | string)[] = []
  let lastReply = ''
  let current: Tier | undefined
  let isOn = true

  function remember(d: Decision | string) {
    recent.push(d)
    if (recent.length > 20) recent.shift()
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'tev1-router: show recent routing decisions; `/router off` or `/router on` to switch it',
      argumentHint: '[on|off]',
    })
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      isOn = arg === 'on'
      $.ui.status(isOn ? undefined : 'router off')
      return { text: `tev1-router is ${isOn ? 'on' : 'off'} for this session.` }
    }
    const lines = recent.length
      ? recent.map(d =>
          typeof d === 'string'
            ? `- kept the session's model: ${d}`
            : `- **${d.tier}** (score ${d.score.toFixed(2)}, ${d.ms} ms${d.kept ? ', kept: too close to switch' : ''}): ${d.prompt}`,
        )
      : ['No prompts routed yet in this session.']
    return {
      text: [`tev1-router is ${isOn ? 'on' : 'off'}. Models: ${models.haiku}, ${models.sonnet}, ${models.opus}.`, '', ...lines].join('\n'),
    }
  })

  on('turn.start', async ($, e, next) => {
    if (isOn && e.agentId === undefined && e.text.trim()) {
      const pending = decide($, cfg, e.text, lastReply, current)
      turns.set(e.turnId, pending)
      void pending.then(d => {
        if (typeof d !== 'string') current = d.tier
        remember(d)
        $.ui.status(typeof d === 'string' ? 'router: tev1 unavailable' : `router → ${d.tier}`)
      })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const pending = e.agentId === undefined ? turns.get(e.turnId) : undefined
    const d = pending ? await pending : undefined
    if (d && typeof d !== 'string' && models[d.tier] !== e.model) {
      return yield* next({ ...e, model: models[d.tier] })
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      turns.delete(e.turnId)
      if ('text' in e && typeof e.text === 'string' && e.text) lastReply = e.text
    }
    return done
  })
}
