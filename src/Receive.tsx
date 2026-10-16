import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, Footprints, PenLine, RotateCcw, ShieldAlert, Truck, XCircle } from 'lucide-react'
import {
  BASE,
  ROUTES,
  changedKinds,
  giftUrl,
  routeBlockers,
  routeLength,
  type Handover,
  type Kind,
  type RouteId,
} from './handover'
import type { Dict } from './i18n'
import { downloadCard } from './card'

const ICONS = { pallet: Footprints, barrier: ShieldAlert, machine: Truck } as const

export const fromOf = (h: Handover, t: Dict) => h.from || (h.sample ? t.sampleFrom : t.previousCrew)
export const noteOf = (h: Handover, k: Kind, t: Dict) => h.changes[k]?.note || (h.sample ? t.sampleNotes[k] : '—')

/** The built-in sample has localized notes; materialize it so it can be shared as a real link. */
export function shareable(h: Handover, t: Dict): Handover {
  if (!h.sample) return h
  const changes = Object.fromEntries(changedKinds(h).map((k) => [k, { after: h.changes[k]!.after, note: t.sampleNotes[k] }]))
  return { from: t.sampleFrom, changes }
}

/** Everything the incoming crew is told about one changed object. */
export function describe(h: Handover, k: Kind, t: Dict) {
  const a = h.changes[k]!.after
  const from = BASE[k]
  const route = ROUTES.find((r) => r.anchors.includes(a))
  const why = route ? t.why.blocks(t.route[route.id]) : a === 'zone' ? t.why.zone() : t.why.clear()
  return {
    title: t.kind[k],
    move: from ? t.moved(t.anchor[from], t.anchor[a]) : t.added(t.anchor[a]),
    note: noteOf(h, k, t),
    why,
    verify: t.verify[k],
  }
}

function useCopy() {
  const [done, setDone] = useState(false)
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setDone(true)
    setTimeout(() => setDone(false), 1600)
  }
  return [done, copy] as const
}

interface PanelProps {
  t: Dict
  handover: Handover
  found: Kind[]
  focus: Kind | null
  chosen: RouteId | null
  attempts: number
  passed: boolean
  walking: boolean
  onFocus: (k: Kind) => void
  onChoose: (id: RouteId) => void
}

export function ReceivePanel({ t, handover, found, focus, chosen, attempts, passed, walking, onFocus, onChoose }: PanelProps) {
  const kinds = changedKinds(handover)
  const allFound = found.length === kinds.length
  const from = fromOf(handover, t)
  const chosenBlockers = chosen ? routeBlockers(handover, chosen) : []
  const routesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (allFound) routesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [allFound])
  return (
    <>
      <div className="panel-head">
        <div>
          <span className="eyebrow">{t.leftFor}</span>
          <h2 className="from">{t.noteFrom(from)}</h2>
          <div className="big">
            <b>{found.length}</b>/{kinds.length}
          </div>
          <span className="muted">{t.notesRead}</span>
        </div>
        <div className="meter" aria-hidden>
          {kinds.map((k) => (
            <i key={k} className={found.includes(k) ? 'on' : ''} />
          ))}
        </div>
      </div>

      <ol className="changes">
        {kinds.map((k, i) => {
          const done = found.includes(k)
          const Icon = ICONS[k]
          const d = done ? describe(handover, k, t) : null
          return (
            <li key={k} className={`${done ? 'done' : ''} ${focus === k ? 'focus' : ''}`}>
              <button disabled={!done} onClick={() => onFocus(k)}>
                <span className="badge">{done ? <Check size={16} strokeWidth={3} /> : i + 1}</span>
                <span className="txt">
                  <strong>
                    {done && <Icon size={14} />} {d ? d.title : `${t.unread} ${i + 1}`}
                  </strong>
                  {d ? (
                    <>
                      <em className="move">{d.move}</em>
                      {focus === k && <q className="note">{d.note}</q>}
                    </>
                  ) : (
                    <span>{t.clue[k]}</span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      {allFound && (
        <div className="routes" ref={routesRef}>
          <h3>{t.routeTitle}</h3>
          {ROUTES.map((r) => {
            const picked = chosen === r.id
            const blocked = picked && !walking && routeBlockers(handover, r.id).length > 0
            return (
              <button
                key={r.id}
                className={`route-btn ${picked && !walking ? (blocked ? 'bad' : 'good') : ''}`}
                disabled={passed || walking}
                onClick={() => onChoose(r.id)}
              >
                <span className="route-letter">{r.id === 'west' ? 'A' : 'B'}</span>
                <span className="route-name">{t.route[r.id]}</span>
                <span className="route-len">≈{routeLength(r)} m</span>
                {picked && !walking && (blocked ? <XCircle size={18} /> : <Check size={18} strokeWidth={3} />)}
              </button>
            )
          })}
          {chosen && (
            <p className={`route-note ${walking ? '' : chosenBlockers.length ? 'bad' : 'good'}`}>
              {walking
                ? t.walking(chosen === 'west' ? 'A' : 'B')
                : chosenBlockers.length
                  ? t.routeBlocked(t.kind[chosenBlockers[0].kind], t.anchor[chosenBlockers[0].anchor])
                  : t.routeOpen}
              {attempts > 0 && !walking && <small> · {t.attempts(attempts)}</small>}
            </p>
          )}
        </div>
      )}
    </>
  )
}

interface EndingProps {
  t: Dict
  handover: Handover
  chosen: RouteId
  attempts: number
  onReview: () => void
  onRestart: () => void
  onCreate: () => void
}

export function Ending({ t, handover, chosen, attempts, onReview, onRestart, onCreate }: EndingProps) {
  const [copied, copy] = useCopy()
  const from = fromOf(handover, t)
  const kinds = changedKinds(handover)
  const chips = kinds.map((k) => `${t.kind[k]}: ${t.anchor[handover.changes[k]!.after]}`)
  const rows: [string, string][] = [
    [t.cardRoute, t.route[chosen]],
    [t.cardResult, t.resultDone],
    [t.cardTries, String(attempts)],
  ]
  const save = () =>
    downloadCard({
      eyebrow: `${t.brand} · ${from}`,
      title: t.endTitle,
      sub: t.endSub,
      rows,
      chips,
      footer: t.endVerify,
    })
  return (
    <div className="ready" role="dialog" aria-label={t.endTitle}>
      <div className="end-card">
        <span className="eyebrow">
          {t.brand} · {from}
        </span>
        <h2>{t.endTitle}</h2>
        <p className="sub">{t.endSub}</p>
        <div className="end-block">
          <span className="label">{t.endChanges(kinds.length)}</span>
          <ul className="chips">
            {chips.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="verify-note">{t.endVerify}</p>
        <div className="ready-actions">
          <button className="btn primary" onClick={onCreate}>
            <PenLine size={15} /> {t.ctaCreate}
          </button>
          <button className="btn ghost" onClick={() => copy(giftUrl(shareable(handover, t)))}>
            <Copy size={15} /> {copied ? t.copied : t.share}
          </button>
        </div>
        <div className="ready-actions second">
          <button className="btn link" onClick={save}>
            <Download size={14} /> {t.savePng}
          </button>
          <button className="btn link" onClick={onReview}>
            {t.review}
          </button>
          <button className="btn link" onClick={onRestart}>
            <RotateCcw size={14} /> {t.restart}
          </button>
        </div>
        <p className="fine">{t.disclaimer}</p>
      </div>
    </div>
  )
}
