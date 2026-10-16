import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, FastForward, HardHat, Pause, PenLine, Play, Rewind, RotateCcw, SkipForward } from 'lucide-react'
import { Scene, type Brief, type RouteUi } from './Scene'
import { LANGS, dict, type Dict, type Lang } from './i18n'
import { ASSET_KINDS, TEAM_DECLARED_TRIPO, useAssetStatuses } from './TripoAsset'
import { showClock } from './showClock'
import {
  ALLOWED,
  SAMPLE,
  WALK_SPEED,
  changedKinds,
  parseHash,
  setAfter,
  walkPlan,
  type AnchorId,
  type Handover,
  type Kind,
  type RouteId,
  type Shift,
} from './handover'
import { CreatePanel } from './Create'
import { Ending, ReceivePanel, describe, fromOf } from './Receive'
import './index.css'

type Mode = 'receive' | 'create'

/** Cinematic timeline (ms of logical progress): BEFORE · CHANGES · ROUTE DECISION · end. */
const PHASE_AT = [0, 2800, 6000]
const CINE_END = 12200

function LangToggle({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <div className="seg seg-sm" role="group" aria-label="Language">
      {LANGS.map((l) => (
        <button key={l.id} className={lang === l.id ? 'on' : ''} aria-pressed={lang === l.id} onClick={() => onChange(l.id)}>
          {l.label}
        </button>
      ))}
    </div>
  )
}

function Sources({ t }: { t: Dict }) {
  const status = useAssetStatuses()
  const glbCount = ASSET_KINDS.filter((k) => status[k] === 'glb').length
  return (
    <details className="sources">
      <summary>{t.sources}</summary>
      <ul>
        {ASSET_KINDS.map((k) => (
          <li key={k}>
            <span>{t.assets[k]}</span>
            <em className={status[k] === 'glb' ? 'glb' : ''}>
              {status[k] === 'checking' ? t.checking : status[k] === 'glb' ? (TEAM_DECLARED_TRIPO ? t.glbTripo : t.glb) : t.procedural}
            </em>
          </li>
        ))}
      </ul>
      <p>
        {ASSET_KINDS.some((k) => status[k] === 'checking')
          ? t.checking
          : glbCount === 0
            ? t.sourcesNone
            : t.sourcesSome(glbCount, ASSET_KINDS.length, TEAM_DECLARED_TRIPO)}
      </p>
    </details>
  )
}

/** Starter draft for the creator: the sample scenario with editable, localized notes. */
const makeDraft = (t: Dict): Handover => ({
  from: '',
  changes: {
    pallet: { after: 'walkway', note: t.sampleNotes.pallet },
    barrier: { after: 'zone', note: t.sampleNotes.barrier },
    machine: { after: 'lane', note: t.sampleNotes.machine },
  },
})

/** True while the creator's draft still holds the untouched starter notes (in any language). */
const isPristine = (d: Handover) =>
  d.from === '' &&
  (Object.keys(d.changes) as Kind[]).every((k) => Object.values(dict).some((x) => x.sampleNotes[k] === d.changes[k]!.note))

const NO_ROUTES: RouteUi = { mode: 'off', chosen: null, walkKey: 0 }

export default function App() {
  const [lang, setLangState] = useState<Lang>('en')
  const t = dict[lang]
  // switching language never resets progress; an untouched starter draft just follows the language
  const setLang = (l: Lang) => {
    setLangState(l)
    setDraft((d) => (isPristine(d) ? makeDraft(dict[l]) : d))
  }

  // --- what the URL contains
  const [link, setLink] = useState(() => parseHash(location.hash))
  const [gift, setGift] = useState<Handover>(() => {
    const r = parseHash(location.hash)
    return r.status === 'ok' ? r.handover : SAMPLE
  })

  const [started, setStarted] = useState(false)
  const [mode, setMode] = useState<Mode>('receive')
  const [resetKey, setResetKey] = useState(0)
  const [shift, setShift] = useState<Shift>('previous')
  const [toast, setToast] = useState<number | null>(null)

  // --- cinematic handover (skippable, replayable): step 0 BEFORE · 1 NOW · 2 routes · 3 finished
  const [cine, setCine] = useState({ run: 0, on: false, step: 3 })

  // --- receive state
  const [found, setFound] = useState<Kind[]>([])
  const [focus, setFocus] = useState<Kind | null>(null)
  const [chosen, setChosen] = useState<RouteId | null>(null)
  const [walkKey, setWalkKey] = useState(0)
  const [walking, setWalking] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [passed, setPassed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const walkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // --- create state
  const [draft, setDraft] = useState<Handover>(() => makeDraft(dict.en))
  const [selected, setSelected] = useState<Kind>('pallet')

  const create = mode === 'create'
  const handover = create ? draft : gift
  const kinds = useMemo(() => changedKinds(gift), [gift])
  const allFound = found.length === kinds.length
  const from = fromOf(gift, t)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    if (toast === null) return
    const id = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(id)
  }, [toast])

  useEffect(() => () => clearTimeout(walkTimer.current), [])

  // The cinematic waits until every model has settled (loaded, or fell back to procedural), so it never
  // plays over objects that are about to swap. Capped at 8 s so a stalled request can't block the demo.
  const assets = useAssetStatuses()
  const [patience, setPatience] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setPatience(true), 8000)
    return () => clearTimeout(id)
  }, [])
  const modelsReady = patience || ASSET_KINDS.every((k) => assets[k] !== 'checking')

  // The cinematic runs on ONE logical progress value (ms), advanced by a rAF loop only while playing.
  // Pausing stops the loop (and freezes the 3D clock, see showClock.ts), so resuming continues from the
  // exact same point: the loop restarts with a fresh "last frame" time and each delta is capped.
  const [paused, setPaused] = useState(false)
  const prog = useRef(0)
  const stepRef = useRef(0)
  const frozen = cine.on && paused

  useEffect(() => {
    showClock.frozen = frozen
    return () => {
      showClock.frozen = false
    }
  }, [frozen])

  useEffect(() => {
    if (!cine.on || !modelsReady || paused) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      prog.current += Math.min(now - last, 100)
      last = now
      const p = prog.current
      if (p >= CINE_END) {
        setCine((c) => ({ ...c, on: false, step: 3 }))
        return
      }
      const step = p >= PHASE_AT[2] ? 2 : p >= PHASE_AT[1] ? 1 : 0
      if (step !== stepRef.current) {
        stepRef.current = step
        setShift(step === 0 ? 'previous' : 'current')
        setCine((c) => ({ ...c, step }))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [cine.on, cine.run, modelsReady, paused])

  const startCine = () => {
    prog.current = 0
    stepRef.current = 0
    setPaused(false)
    setShift('previous')
    setCine((c) => ({ run: c.run + 1, on: true, step: 0 }))
  }
  const skipCine = () => {
    setPaused(false)
    setShift('current')
    setCine((c) => ({ ...c, on: false, step: 3 }))
  }
  /** Jump to the start of a phase (BEFORE / CHANGES / ROUTE DECISION) and keep playing from there. */
  const goPhase = (n: number) => {
    const step = Math.max(0, Math.min(2, n))
    prog.current = PHASE_AT[step]
    stepRef.current = step
    setPaused(false)
    setShift(step === 0 ? 'previous' : 'current')
    setCine((c) => ({ ...c, step }))
  }

  // Space toggles pause while the cinematic is active (never while typing)
  useEffect(() => {
    if (!cine.on) return
    const isSpace = (e: KeyboardEvent) => e.code === 'Space' || e.key === ' '
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
    }
    const down = (e: KeyboardEvent) => {
      if (!isSpace(e) || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      if (!e.repeat) setPaused((p) => !p)
    }
    const up = (e: KeyboardEvent) => {
      if (isSpace(e) && !typing(e)) e.preventDefault() // stop a focused button from also "clicking"
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [cine.on])

  const resetReceive = () => {
    clearTimeout(walkTimer.current)
    setWalking(false)
    setFound([])
    setFocus(null)
    setChosen(null)
    setAttempts(0)
    setPassed(false)
    setDismissed(false)
    setToast(null)
    setShift('previous')
    setResetKey((k) => k + 1)
  }

  // open a pasted / edited gift link while the app is running
  useEffect(() => {
    const onHash = () => {
      const r = parseHash(location.hash)
      if (r.status === 'none') return
      setLink(r)
      if (r.status === 'ok') setGift(r.handover)
      setMode('receive')
      setStarted(false)
      setCine((c) => ({ ...c, on: false, step: 3 }))
      resetReceive()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const enterMode = (m: Mode) => {
    setMode(m)
    resetReceive()
    if (m === 'create') {
      setCine((c) => ({ ...c, on: false, step: 3 }))
      setShift('current')
    } else startCine()
  }

  const enter = (m: Mode) => {
    setStarted(true)
    enterMode(m)
  }

  const watchSample = () => {
    setGift(SAMPLE)
    setLink({ status: 'none' })
    history.replaceState(null, '', location.pathname)
    enter('receive')
  }

  const switchMode = (m: Mode) => {
    if (m !== mode) enterMode(m)
  }

  const restart = () => {
    if (create) {
      setDraft(makeDraft(t))
      setSelected('pallet')
      setShift('current')
      setResetKey((k) => k + 1)
    } else {
      resetReceive()
      startCine()
    }
  }

  const select = (k: Kind) => {
    if (create) {
      setSelected(k)
      return
    }
    setFound((f) => (f.includes(k) ? f : [...f, k]))
    setFocus((cur) => (cur === k ? null : k))
  }

  const pickPad = (a: AnchorId) => {
    if (!ALLOWED[selected].includes(a)) return
    setDraft((d) => setAfter(d, selected, a))
    setShift('current')
  }

  const choose = (id: RouteId) => {
    if (walking) return
    const plan = walkPlan(gift, id, 'current')
    setChosen(id)
    setAttempts((n) => n + 1)
    setShift('current')
    setWalkKey((k) => k + 1)
    setWalking(true)
    clearTimeout(walkTimer.current)
    // the indicator walks the route (and stops at an obstruction); only then is the outcome shown
    walkTimer.current = setTimeout(() => {
      setWalking(false)
      if (!plan.blocked) setPassed(true)
    }, (plan.stop / WALK_SPEED) * 1000 + 900)
  }

  const previewAsReceiver = () => {
    setGift({ ...draft })
    setLink({ status: 'none' })
    setMode('receive')
    resetReceive()
    startCine()
  }

  const letter = chosen === 'west' ? 'A' : 'B'
  const inRoutePhase = !create && allFound && !passed
  const hint = cine.on
    ? modelsReady
      ? t.cine[cine.step] ?? ''
      : t.preparing
    : create
      ? t.hintCreate
      : passed
        ? t.hintDone
        : inRoutePhase
          ? t.hintRoute
          : shift === 'previous'
            ? t.hintPrevious
            : t.hintCurrent

  const routeUi: RouteUi =
    create || !started
      ? NO_ROUTES
      : cine.on
        ? cine.step === 1
          ? NO_ROUTES
          : { mode: 'reveal', chosen: null, walkKey: 0 }
        : { mode: 'neutral', chosen, walkKey }

  const brief: Brief | null =
    !create && !cine.on && !chosen && focus && found.includes(focus) && shift === 'current' ? { kind: focus, from, ...describe(gift, focus, t) } : null

  const chip =
    !create && started && !cine.on && !passed && chosen ? (walking ? t.walking(letter) : t.chipBlocked(letter)) : null

  return (
    <div className={`app${frozen ? ' show-paused' : ''}`}>
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            <HardHat size={18} />
          </span>
          <div>
            <h1>{t.brand}</h1>
            <p>{t.tagline}</p>
          </div>
        </div>
        <div className="top-right">
          {started && (
            <div className="seg seg-sm" role="group" aria-label="Mode">
              <button className={!create ? 'on' : ''} aria-pressed={!create} onClick={() => switchMode('receive')}>
                <Play size={12} /> {t.navExperience}
              </button>
              <button className={create ? 'on' : ''} aria-pressed={create} onClick={() => switchMode('create')}>
                <PenLine size={12} /> {t.navCreate}
              </button>
            </div>
          )}
          <LangToggle lang={lang} onChange={setLang} />
          {started && (
            <button className="btn ghost" onClick={restart}>
              <RotateCcw size={15} /> {t.restart}
            </button>
          )}
        </div>
      </header>

      <main className={`main ${started ? '' : 'solo'}`}>
        <section className="viewport">
          <Scene
            handover={handover}
            shift={shift}
            mode={mode}
            markers={create ? (draft.changes[selected] ? [selected] : []) : cine.on ? [] : kinds}
            found={found}
            focus={focus}
            resetKey={resetKey}
            intro={!started}
            selectedKind={create ? selected : null}
            routeUi={routeUi}
            callouts={cine.on && cine.step === 1}
            brief={brief}
            onSelect={select}
            onPad={pickPad}
            onDecoy={() => setToast(Date.now())}
            t={t}
          />

          {started && (
            <div className={`shift-badge ${shift}`} key={shift} aria-live="polite">
              <b>{shift === 'previous' ? t.before : t.now}</b>
              <small>{shift === 'previous' ? t.beforeSub : t.nowSub}</small>
            </div>
          )}

          {chip && (
            <div className={`route-chip ${walking ? '' : 'bad'}`} role="status">
              {chip}
            </div>
          )}

          {started && !create && !cine.on && (
            <div className="hud hud-tl">
              <span className="hud-num">
                {found.length}/{kinds.length}
              </span>
              <span className="hud-label">{t.notesRead}</span>
            </div>
          )}

          {toast !== null && <div className="toast">{t.decoy}</div>}

          {started && (
            <div className="dock">
              <p className={`hint ${cine.on ? 'cine' : ''}`} key={cine.on ? `c${cine.step}` : 'h'}>
                {hint}
              </p>
              {cine.on ? (
                <div className="presenter">
                  <div className="phase-row">
                    <button className="btn ghost step" onClick={() => goPhase(cine.step - 1)} disabled={cine.step <= 0 || !modelsReady} aria-label={t.prevStep} title={t.prevStep}>
                      <ChevronLeft size={16} /> {t.prevStep}
                    </button>
                    <ol className="phases" aria-label={t.phases[cine.step]}>
                      {t.phases.map((p, i) => (
                        <li key={p} className={i === cine.step ? 'on' : i < cine.step ? 'past' : ''} aria-current={i === cine.step ? 'step' : undefined}>
                          {p}
                        </li>
                      ))}
                    </ol>
                    <button className="btn ghost step" onClick={() => goPhase(cine.step + 1)} disabled={cine.step >= 2 || !modelsReady} aria-label={t.nextStep} title={t.nextStep}>
                      {t.nextStep} <ChevronRight size={16} />
                    </button>
                  </div>
                  <div className="ctl-row">
                    <button className="btn pause" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
                      {paused ? <Play size={16} /> : <Pause size={16} />} {paused ? t.resume : t.pause}
                      <kbd>Space</kbd>
                    </button>
                    <button className="btn ghost" onClick={startCine}>
                      <RotateCcw size={15} /> {t.replay}
                    </button>
                    <button className="btn ghost skip" onClick={skipCine}>
                      <SkipForward size={15} /> {t.skip}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="dock-row">
                  <div className="seg seg-lg" role="group" aria-label="Shift">
                    <button className={shift === 'previous' ? 'on' : ''} aria-pressed={shift === 'previous'} onClick={() => setShift('previous')}>
                      <Rewind size={15} /> {t.previous}
                    </button>
                    <button
                      className={`${shift === 'current' ? 'on' : ''} ${shift === 'previous' && !create && found.length === 0 ? 'nudge' : ''}`}
                      aria-pressed={shift === 'current'}
                      onClick={() => setShift('current')}
                    >
                      {t.current} <FastForward size={15} />
                    </button>
                  </div>
                  {!create && (
                    <button className="btn ghost replay" onClick={startCine}>
                      <RotateCcw size={15} /> {t.replay}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {!create && started && passed && chosen && !dismissed && (
            <Ending
              t={t}
              handover={gift}
              chosen={chosen}
              attempts={attempts}
              onReview={() => setDismissed(true)}
              onRestart={restart}
              onCreate={() => switchMode('create')}
            />
          )}

          {!started && (
            <div className="hero">
              <span className="eyebrow">{t.eyebrow}</span>
              <h2>{link.status === 'ok' ? t.giftWaiting(from) : t.heroHeadline}</h2>
              <p className="hero-sub">{link.status === 'ok' ? t.giftSub : t.heroSub}</p>

              {link.status === 'invalid' && (
                <div className="bad-link" role="alert">
                  <strong>{t.giftBadTitle}</strong>
                  <span>{t.giftBadBody}</span>
                </div>
              )}

              <div className="cta-row">
                <button className="btn primary xl" onClick={() => (link.status === 'ok' ? enter('receive') : watchSample())}>
                  {link.status === 'ok' ? t.ctaReceive : t.ctaWatch} <ArrowRight size={18} />
                </button>
                <button className="btn ghost xl" onClick={() => enter('create')}>
                  <PenLine size={18} /> {t.ctaCreate}
                </button>
              </div>
              <p className="hero-quote">{t.heroQuote}</p>
              <span className="meta">{t.disclaimer}</span>
            </div>
          )}
        </section>

        {started && (
          <aside className="panel">
            {create ? (
              <CreatePanel
                t={t}
                draft={draft}
                setDraft={setDraft}
                selected={selected}
                setSelected={setSelected}
                onPreview={previewAsReceiver}
              />
            ) : (
              <ReceivePanel
                t={t}
                handover={gift}
                found={found}
                focus={focus}
                chosen={chosen}
                attempts={attempts}
                passed={passed}
                walking={walking}
                onFocus={setFocus}
                onChoose={choose}
              />
            )}
            <Sources t={t} />
            <p className="fine">{t.disclaimer}</p>
          </aside>
        )}
      </main>
    </div>
  )
}
