import { useState } from 'react'
import { Check, Copy, Eye, Link2, MapPin } from 'lucide-react'
import {
  ALLOWED,
  KINDS,
  MAX_NAME,
  MAX_NOTE,
  ROUTES,
  canPlace,
  giftUrl,
  problem,
  routeBlockers,
  setAfter,
  setNote,
  toggleKind,
  type Handover,
  type Kind,
} from './handover'
import type { Dict } from './i18n'

interface Props {
  t: Dict
  draft: Handover
  setDraft: (fn: (d: Handover) => Handover) => void
  selected: Kind
  setSelected: (k: Kind) => void
  onPreview: () => void
}

export function CreatePanel({ t, draft, setDraft, selected, setSelected, onPreview }: Props) {
  const [made, setMade] = useState<{ draft: Handover; url: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [showProblem, setShowProblem] = useState(false)

  const issue = problem(draft)
  const change = draft.changes[selected]
  const link = made && made.draft === draft ? made.url : null

  const create = () => {
    setShowProblem(true)
    if (issue) return
    const url = giftUrl(draft)
    history.replaceState(null, '', url)
    setMade({ draft, url })
  }
  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      /* fall back to manual copy from the readonly field */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <>
      <div className="panel-head col">
        <span className="eyebrow">{t.createTitle}</span>
        <p className="muted">{t.createSub}</p>
        <label className="field">
          <span>{t.yourName}</span>
          <input
            value={draft.from}
            maxLength={MAX_NAME}
            placeholder={t.namePh}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
          />
        </label>
      </div>

      <div>
        <span className="label">{t.objects}</span>
        <div className="kinds">
          {KINDS.map((k) => (
            <button key={k} className={`kind ${selected === k ? 'on' : ''} ${draft.changes[k] ? 'inc' : ''}`} onClick={() => setSelected(k)}>
              <i>{draft.changes[k] ? <Check size={12} strokeWidth={3} /> : null}</i>
              {t.kind[k]}
            </button>
          ))}
        </div>
      </div>

      <div className="editor">
        <label className="switch">
          <input type="checkbox" checked={!!change} onChange={(e) => setDraft((d) => toggleKind(d, selected, e.target.checked))} />
          <span>{t.include}</span>
        </label>

        {change && (
          <>
            <span className="label">{t.moveTo}</span>
            <div className="anchors">
              {ALLOWED[selected].map((a) => {
                const free = canPlace(draft, selected, a)
                return (
                  <button
                    key={a}
                    disabled={!free}
                    className={`anchor ${change.after === a ? 'on' : ''}`}
                    onClick={() => setDraft((d) => setAfter(d, selected, a))}
                  >
                    <MapPin size={12} /> {t.anchor[a]}
                  </button>
                )
              })}
            </div>
            <p className="muted small">{t.padHint}</p>

            <label className="field">
              <span>
                {t.yourNote} <em>{t.noteCount(change.note.length)}</em>
              </span>
              <textarea
                rows={3}
                maxLength={MAX_NOTE}
                value={change.note}
                placeholder={t.notePh}
                onChange={(e) => setDraft((d) => setNote(d, selected, e.target.value))}
              />
            </label>
          </>
        )}
      </div>

      <div className="routecheck">
        <span className="label">{t.routeCheck}</span>
        {ROUTES.map((r) => {
          const b = routeBlockers(draft, r.id)
          return (
            <div key={r.id} className={`rc ${b.length ? 'bad' : 'good'}`}>
              <strong>{t.route[r.id]}</strong>
              <span>{b.length ? t.blockedBy(t.kind[b[0].kind], t.anchor[b[0].anchor]) : t.open}</span>
            </div>
          )
        })}
      </div>

      {showProblem && issue && <p className="problem">{t.problems[issue]}</p>}

      <div className="actions">
        <button className="btn primary wide" onClick={create}>
          <Link2 size={15} /> {t.makeLink}
        </button>
        <button className="btn ghost wide" onClick={onPreview} disabled={!!issue}>
          <Eye size={15} /> {t.previewAsReceiver}
        </button>
      </div>

      {link && (
        <div className="linkbox">
          <span className="label ok">
            <Check size={13} strokeWidth={3} /> {t.linkReady}
          </span>
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn primary wide" onClick={copy}>
            <Copy size={15} /> {copied ? t.copied : t.copyLink}
          </button>
        </div>
      )}
    </>
  )
}
