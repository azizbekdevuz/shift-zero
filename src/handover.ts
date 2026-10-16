// Pure data + logic for a handover: world anchors, routes, validation and URL codec.
// No React, no Three, no network.

export type Vec3 = [number, number, number]
export type Shift = 'previous' | 'current'
export type Kind = 'pallet' | 'barrier' | 'machine'
export const KINDS: Kind[] = ['pallet', 'barrier', 'machine']

export const ANCHOR_IDS = ['storage', 'walkway', 'lane', 'northAisle', 'eastAisle', 'parking', 'zone'] as const
export type AnchorId = (typeof ANCHOR_IDS)[number]

/** Safe, predefined floor slots. `axis` is the direction the route/slot runs along. */
export const ANCHORS: Record<AnchorId, { pos: Vec3; axis: 'x' | 'z' }> = {
  storage: { pos: [-9, 0, -2], axis: 'z' },
  walkway: { pos: [-5, 0, 0], axis: 'z' },
  lane: { pos: [2.5, 0, 4], axis: 'x' },
  northAisle: { pos: [5.5, 0, -7.1], axis: 'x' },
  eastAisle: { pos: [10.8, 0, -2.5], axis: 'z' },
  parking: { pos: [7, 0, 0.5], axis: 'x' },
  zone: { pos: [5, 0, -3.5], axis: 'x' },
}

/** Where each object rests before the handover. A barricade doesn't exist yet. */
export const BASE: Record<Kind, AnchorId | null> = { pallet: 'storage', barrier: null, machine: 'parking' }

export const ALLOWED: Record<Kind, AnchorId[]> = {
  pallet: ['walkway', 'lane', 'northAisle', 'eastAisle', 'parking'],
  barrier: ['zone', 'walkway', 'lane', 'northAisle', 'eastAisle'],
  machine: ['lane', 'walkway', 'northAisle', 'eastAisle', 'storage'],
}

export type RouteId = 'west' | 'north'
export interface Route {
  id: RouteId
  anchors: AnchorId[]
  /** polyline on the floor, [x, z] pairs */
  path: [number, number][]
}
export const ROUTES: Route[] = [
  { id: 'west', anchors: ['walkway', 'lane'], path: [[-5, -8], [-5, 4], [9.9, 4]] },
  { id: 'north', anchors: ['northAisle', 'eastAisle'], path: [[-5, -8], [-5, -7.1], [10.8, -7.1], [10.8, 4], [9.9, 4]] },
]
export const routeLength = (r: Route) =>
  Math.round(r.path.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - r.path[i][0], p[1] - r.path[i][1]), 0))

export interface Change {
  after: AnchorId
  note: string
}
export interface Handover {
  from: string
  changes: Partial<Record<Kind, Change>>
  /** built-in sample: empty strings fall back to localized copy */
  sample?: boolean
}

export const MAX_NOTE = 140
export const MAX_NAME = 24

export const SAMPLE: Handover = {
  from: '',
  sample: true,
  changes: {
    pallet: { after: 'walkway', note: '' },
    barrier: { after: 'zone', note: '' },
    machine: { after: 'lane', note: '' },
  },
}

export const changedKinds = (h: Handover) => KINDS.filter((k) => h.changes[k])

export function placeOf(h: Handover, kind: Kind, shift: Shift): AnchorId | null {
  if (shift === 'previous') return BASE[kind]
  return h.changes[kind]?.after ?? BASE[kind]
}

/** Who sits on each anchor in the given shift. */
export function occupancy(h: Handover, shift: Shift) {
  const map = new Map<AnchorId, Kind[]>()
  for (const k of KINDS) {
    const a = placeOf(h, k, shift)
    if (a) map.set(a, [...(map.get(a) ?? []), k])
  }
  return map
}

export interface Blocker {
  kind: Kind
  anchor: AnchorId
}
export function routeBlockers(h: Handover, id: RouteId, shift: Shift = 'current'): Blocker[] {
  const route = ROUTES.find((r) => r.id === id)!
  const occ = occupancy(h, shift)
  return route.anchors.flatMap((anchor) => (occ.get(anchor) ?? []).map((kind) => ({ kind, anchor })))
}

// ---- walking a route: where does the indicator stop? ------------------------
export const WALK_SPEED = 8 // metres per second for the route indicator

const segLen = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1])

export interface WalkPlan {
  total: number
  /** distance along the path at which the indicator stops (== total when the route is open) */
  stop: number
  blocked: boolean
  blockers: Blocker[]
}

/** Distance along `path` of the point closest to (x, z). */
function alongPath(path: [number, number][], x: number, z: number) {
  let best = { d: Infinity, along: 0 }
  let cum = 0
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1]
    const [bx, bz] = path[i]
    const len = segLen(path[i - 1], path[i])
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (len * len))) : 0
    const d = Math.hypot(x - (ax + (bx - ax) * t), z - (az + (bz - az) * t))
    if (d < best.d) best = { d, along: cum + t * len }
    cum += len
  }
  return best.along
}

export function walkPlan(h: Handover, id: RouteId, shift: Shift = 'current'): WalkPlan {
  const route = ROUTES.find((r) => r.id === id)!
  const total = route.path.slice(1).reduce((s, p, i) => s + segLen(route.path[i], p), 0)
  const blockers = routeBlockers(h, id, shift)
  let stop = total
  for (const b of blockers) {
    const p = ANCHORS[b.anchor].pos
    stop = Math.min(stop, Math.max(0, alongPath(route.path, p[0], p[2]) - 1.9))
  }
  return { total, stop, blocked: blockers.length > 0, blockers }
}

/** Point at distance `d` along a polyline, as [x, z]. */
export function pointAt(path: [number, number][], d: number): [number, number] {
  let left = Math.max(0, d)
  for (let i = 1; i < path.length; i++) {
    const len = segLen(path[i - 1], path[i])
    if (left <= len || i === path.length - 1) {
      const t = len ? Math.min(1, left / len) : 0
      return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t]
    }
    left -= len
  }
  return path[path.length - 1]
}

/** Splits a polyline at distance `d` into the part before and after. Both share the split point. */
export function splitPath(path: [number, number][], d: number): { before: [number, number][]; after: [number, number][] } {
  const before: [number, number][] = [path[0]]
  const after: [number, number][] = []
  let cum = 0
  let split = false
  for (let i = 1; i < path.length; i++) {
    const len = segLen(path[i - 1], path[i])
    if (!split && cum + len >= d) {
      const p = pointAt(path, d)
      before.push(p)
      after.push(p)
      split = true
    } else if (!split) before.push(path[i])
    if (split && cum + len >= d) after.push(path[i])
    cum += len
  }
  return { before, after }
}

export function canPlace(h: Handover, kind: Kind, anchor: AnchorId) {
  if (!ALLOWED[kind].includes(anchor)) return false
  return !KINDS.some((k) => k !== kind && placeOf(h, k, 'current') === anchor)
}

export type Problem = 'empty' | 'conflict' | 'noRoute' | 'note'
export function problem(h: Handover): Problem | null {
  const kinds = changedKinds(h)
  if (!kinds.length) return 'empty'
  for (const k of kinds) {
    const c = h.changes[k]!
    if (!ALLOWED[k].includes(c.after) || c.after === BASE[k]) return 'conflict'
  }
  const occ = occupancy(h, 'current')
  if ([...occ.values()].some((v) => v.length > 1)) return 'conflict'
  if (ROUTES.every((r) => routeBlockers(h, r.id).length > 0)) return 'noRoute'
  if (kinds.some((k) => !h.changes[k]!.note.trim() && !h.sample)) return 'note'
  return null
}

// ---- editing helpers (immutable) -------------------------------------------
export function toggleKind(h: Handover, kind: Kind, on: boolean): Handover {
  const changes = { ...h.changes }
  if (!on) delete changes[kind]
  else {
    const after = ALLOWED[kind].find((a) => canPlace(h, kind, a))
    if (after) changes[kind] = { after, note: '' }
  }
  return { ...h, changes }
}
export function setAfter(h: Handover, kind: Kind, after: AnchorId): Handover {
  if (!canPlace(h, kind, after)) return h
  return { ...h, changes: { ...h.changes, [kind]: { after, note: h.changes[kind]?.note ?? '' } } }
}
export function setNote(h: Handover, kind: Kind, note: string): Handover {
  const c = h.changes[kind]
  if (!c) return h
  return { ...h, changes: { ...h.changes, [kind]: { ...c, note: note.slice(0, MAX_NOTE) } } }
}

// ---- URL codec: #gift=<base64url(JSON)> ------------------------------------
const PREFIX = '#gift='
const MAX_ENCODED = 3000
const CODE: Record<Kind, 'p' | 'b' | 'm'> = { pallet: 'p', barrier: 'b', machine: 'm' }

const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? Array.from(v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, max).join('') : ''

function toB64Url(text: string) {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64Url(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export function encodeHandover(h: Handover): string {
  const payload: Record<string, unknown> = { v: 1, f: clean(h.from, MAX_NAME) }
  for (const k of changedKinds(h)) payload[CODE[k]] = { a: h.changes[k]!.after, n: clean(h.changes[k]!.note, MAX_NOTE) }
  return PREFIX + toB64Url(JSON.stringify(payload))
}

export type ParseResult = { status: 'none' } | { status: 'invalid' } | { status: 'ok'; handover: Handover }

export function parseHash(hash: string): ParseResult {
  if (!hash.startsWith(PREFIX)) return { status: 'none' }
  const raw = hash.slice(PREFIX.length)
  if (!raw || raw.length > MAX_ENCODED || !/^[A-Za-z0-9_-]+$/.test(raw)) return { status: 'invalid' }
  try {
    const data: unknown = JSON.parse(fromB64Url(raw))
    if (typeof data !== 'object' || data === null || (data as { v?: unknown }).v !== 1) return { status: 'invalid' }
    const obj = data as Record<string, unknown>
    const h: Handover = { from: clean(obj.f, MAX_NAME), changes: {} }
    for (const k of KINDS) {
      const c = obj[CODE[k]]
      if (c === undefined) continue
      if (typeof c !== 'object' || c === null) return { status: 'invalid' }
      const a = (c as { a?: unknown }).a
      if (typeof a !== 'string' || !(ANCHOR_IDS as readonly string[]).includes(a)) return { status: 'invalid' }
      h.changes[k] = { after: a as AnchorId, note: clean((c as { n?: unknown }).n, MAX_NOTE) }
    }
    if (problem({ ...h, sample: true }) !== null) return { status: 'invalid' }
    return { status: 'ok', handover: h }
  } catch {
    return { status: 'invalid' }
  }
}

export const giftUrl = (h: Handover) => `${location.origin}${location.pathname}${encodeHandover(h)}`
