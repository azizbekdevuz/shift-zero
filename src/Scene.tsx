import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { useShowClockTick, useShowFrame } from './showClock'
import { Grid, Html, Line, OrbitControls, useCursor } from '@react-three/drei'
import * as THREE from 'three'
import { TripoAsset, useAssetStatuses, type Size3 } from './TripoAsset'
import {
  ALLOWED,
  ANCHORS,
  BASE,
  KINDS,
  ROUTES,
  canPlace,
  occupancy,
  placeOf,
  WALK_SPEED,
  pointAt,
  splitPath,
  walkPlan,
  type AnchorId,
  type Handover,
  type Kind,
  type RouteId,
  type Shift,
  type Vec3,
  type WalkPlan,
} from './handover'
import type { Dict } from './i18n'

const AMBER = '#f5a524'
const HOME_DIR = new THREE.Vector3(14.5, 12.5, 15.5).normalize()
const ORIGIN: Vec3 = [0, 0, 0]

const PALLET_SIZE: Size3 = [1.2, 0.85, 1.2] // fit box for a loaded-pallet GLB
const BARRIER_SIZE: Size3 = [2.2, 1, 0.3]
const MACHINE_SIZE: Size3 = [3.4, 2.3, 2.2]
const CONE_SIZE: Size3 = [0.5, 0.8, 0.5]
const RACK_SIZE: Size3 = [2.4, 2.3, 0.9]
const CABINET_SIZE: Size3 = [1.7, 1.6, 0.8]

const MARKER_Y: Record<Kind, number> = { pallet: 3.1, barrier: 2.7, machine: 3.5 }
const ROUTE_ANCHORS: AnchorId[] = ['walkway', 'lane', 'northAisle', 'eastAisle']
const TAG_AT: Record<AnchorId, Vec3> = {
  storage: [-9, 0.3, 0.2],
  walkway: [-5, 0.3, 6.4],
  lane: [-1.2, 0.3, 4],
  northAisle: [0.2, 0.3, -7.1],
  eastAisle: [10.8, 0.3, 1.2],
  parking: [7, 0.3, 2.4],
  zone: [5, 0.3, -0.4],
}

// ---------- helpers ----------------------------------------------------------
function useStripes(a: string, b: string, rx: number, ry: number) {
  return useMemo(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const ctx = c.getContext('2d')!
    ctx.fillStyle = b
    ctx.fillRect(0, 0, 128, 128)
    ctx.strokeStyle = a
    ctx.lineWidth = 22
    for (let k = 0; k < 5; k++) {
      ctx.beginPath()
      ctx.moveTo(-128 + k * 64, 0)
      ctx.lineTo(k * 64, 128)
      ctx.stroke()
    }
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(rx, ry)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [a, b, rx, ry])
}

/** Smoothly scales a group in/out when `show` changes. */
function Pop({ show, position = ORIGIN, children }: { show: boolean; position?: Vec3; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null)
  const k = useRef(show ? 1 : 0)
  useShowFrame((_, dt) => {
    const g = ref.current
    if (!g) return
    k.current = THREE.MathUtils.damp(k.current, show ? 1 : 0, 5, dt)
    g.visible = k.current > 0.01
    g.scale.setScalar(Math.max(k.current, 0.001))
  })
  return (
    <group ref={ref} position={position}>
      {children}
    </group>
  )
}

/** Glides a group to an anchor (and fades it in/out when `at` is null). Rewind/forward = change `at`. */
function Mover({ at, rot, appear = false, children }: { at: AnchorId | null; rot?: (a: AnchorId) => number; appear?: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null)
  const k = useRef(at && !appear ? 1 : 0)
  const placed = useRef(false)
  useShowFrame((_, dt) => {
    const g = ref.current
    if (!g) return
    if (at) {
      const p = ANCHORS[at].pos
      const r = rot ? rot(at) : 0
      if (!placed.current || k.current < 0.02) {
        g.position.set(p[0], g.position.y, p[2])
        g.rotation.y = r
        placed.current = true
      } else {
        g.position.x = THREE.MathUtils.damp(g.position.x, p[0], 2.6, dt)
        g.position.z = THREE.MathUtils.damp(g.position.z, p[2], 2.6, dt)
        g.rotation.y = THREE.MathUtils.damp(g.rotation.y, r, 3, dt)
      }
    }
    k.current = THREE.MathUtils.damp(k.current, at ? 1 : 0, 5, dt)
    g.visible = k.current > 0.01
    g.scale.setScalar(Math.max(k.current, 0.001))
    g.position.y = at ? (1 - k.current) * 3 : 0
  })
  return <group ref={ref}>{children}</group>
}

/** Pointer cursor + click on a group, only when `enabled`. */
function Clickable({ enabled, onClick, children }: { enabled: boolean; onClick: () => void; children: ReactNode }) {
  const [hover, setHover] = useState(false)
  useCursor(hover && enabled)
  if (!enabled) return <group>{children}</group>
  return (
    <group
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation()
        onClick()
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation()
        setHover(true)
      }}
      onPointerOut={() => setHover(false)}
    >
      {children}
    </group>
  )
}

function Tag({ text, position, tone = 'neutral' }: { text: string; position: Vec3; tone?: 'neutral' | 'amber' | 'red' | 'green' }) {
  return (
    <Html position={position} center className="no-pe" zIndexRange={[5, 0]}>
      <div className={`tag tag-${tone}`}>{text}</div>
    </Html>
  )
}

// ---------- procedural assets (fallbacks) -------------------------------------
function PalletMesh() {
  return (
    <group>
      {[-0.5, 0, 0.5].map((x) => (
        <mesh key={x} position={[x, 0.05, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.16, 0.1, 1]} />
          <meshStandardMaterial color="#8f6a3c" roughness={0.9} />
        </mesh>
      ))}
      {[-0.4, -0.2, 0, 0.2, 0.4].map((z) => (
        <mesh key={z} position={[0, 0.125, z]} castShadow receiveShadow>
          <boxGeometry args={[1.2, 0.05, 0.16]} />
          <meshStandardMaterial color="#b98a52" roughness={0.85} />
        </mesh>
      ))}
    </group>
  )
}

function BarrierMesh() {
  const tex = useStripes('#e5484d', '#f4f4f0', 3, 1)
  return (
    <group>
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 1.0, 0, 0]}>
          <mesh position={[0, 0.5, 0]} castShadow>
            <boxGeometry args={[0.1, 1, 0.1]} />
            <meshStandardMaterial color="#2b3446" />
          </mesh>
          <mesh position={[0, 0.04, 0]} castShadow>
            <boxGeometry args={[0.2, 0.08, 0.7]} />
            <meshStandardMaterial color="#1f2736" />
          </mesh>
        </group>
      ))}
      {[0.85, 0.5].map((y) => (
        <mesh key={y} position={[0, y, 0]} castShadow>
          <boxGeometry args={[2.1, 0.16, 0.05]} />
          <meshStandardMaterial map={tex} roughness={0.6} />
        </mesh>
      ))}
    </group>
  )
}

function MachineMesh() {
  return (
    <group>
      {[-0.85, 0.85].map((z) => (
        <mesh key={z} position={[0, 0.28, z]} castShadow receiveShadow>
          <boxGeometry args={[3, 0.56, 0.5]} />
          <meshStandardMaterial color="#1b2230" roughness={0.9} />
        </mesh>
      ))}
      <mesh position={[0, 0.95, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.3, 0.8, 1.6]} />
        <meshStandardMaterial color="#e0a526" roughness={0.55} metalness={0.2} />
      </mesh>
      <mesh position={[-0.5, 1.6, 0]} castShadow>
        <boxGeometry args={[1, 0.7, 1.1]} />
        <meshStandardMaterial color="#e0a526" roughness={0.55} metalness={0.2} />
      </mesh>
      <mesh position={[-0.28, 1.65, 0]}>
        <boxGeometry args={[0.6, 0.45, 1.12]} />
        <meshStandardMaterial color="#14233d" roughness={0.2} metalness={0.6} />
      </mesh>
      <mesh position={[1.45, 1.15, 0]} rotation={[0, 0, -0.35]} castShadow>
        <boxGeometry args={[1.5, 0.22, 0.3]} />
        <meshStandardMaterial color="#c58a14" />
      </mesh>
      <mesh position={[2.15, 0.7, 0]} castShadow>
        <boxGeometry args={[0.5, 0.45, 1.2]} />
        <meshStandardMaterial color="#2b3446" />
      </mesh>
      <mesh position={[0.4, 1.45, 0.5]}>
        <sphereGeometry args={[0.1, 12, 12]} />
        <meshStandardMaterial color={AMBER} emissive={AMBER} emissiveIntensity={2} />
      </mesh>
    </group>
  )
}

function ConeMesh() {
  return (
    <group>
      <mesh position={[0, 0.04, 0]}>
        <boxGeometry args={[0.5, 0.08, 0.5]} />
        <meshStandardMaterial color="#1f2736" />
      </mesh>
      <mesh position={[0, 0.42, 0]}>
        <coneGeometry args={[0.2, 0.72, 20]} />
        <meshStandardMaterial color="#ff7a1a" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.4, 0]}>
        <cylinderGeometry args={[0.12, 0.135, 0.1, 20]} />
        <meshStandardMaterial color="#f4f4f0" />
      </mesh>
    </group>
  )
}

function CabinetMesh() {
  return (
    <group>
      <mesh position={[0, 0.75, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.6, 1.5, 0.7]} />
        <meshStandardMaterial color="#3a4a6b" metalness={0.4} roughness={0.5} />
      </mesh>
      {[0.3, 0.7, 1.1].map((y) => (
        <mesh key={y} position={[0, y, 0.36]}>
          <boxGeometry args={[1.4, 0.3, 0.02]} />
          <meshStandardMaterial color="#26324a" />
        </mesh>
      ))}
    </group>
  )
}

function RackMesh() {
  return (
    <group>
      {[-1.1, 1.1].flatMap((x) =>
        [-0.35, 0.35].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 1.1, z]} castShadow>
            <boxGeometry args={[0.07, 2.2, 0.07]} />
            <meshStandardMaterial color="#3a4a6b" />
          </mesh>
        )),
      )}
      {[0.4, 1.2, 2].map((y) => (
        <mesh key={y} position={[0, y, 0]} castShadow receiveShadow>
          <boxGeometry args={[2.3, 0.06, 0.8]} />
          <meshStandardMaterial color="#c07a2a" />
        </mesh>
      ))}
      {[
        [-0.6, 0.62],
        [0.5, 1.4],
        [-0.2, 2.2],
      ].map(([x, y]) => (
        <mesh key={`${x}${y}`} position={[x, y, 0]} castShadow>
          <boxGeometry args={[0.6, 0.4, 0.55]} />
          <meshStandardMaterial color="#6d5a45" />
        </mesh>
      ))}
    </group>
  )
}

function Cone({ position }: { position: Vec3 }) {
  return (
    <group position={position}>
      <TripoAsset kind="cone" size={CONE_SIZE}>
        <ConeMesh />
      </TripoAsset>
    </group>
  )
}

// ---------- scene pieces -----------------------------------------------------
function PalletStack() {
  const glb = useAssetStatuses().pallet === 'glb'
  const step = glb ? 0.86 : 0.15
  const gap = glb ? 0.65 : 0.6
  const heights = glb ? [2, 1, 1, 2] : [4, 3, 3, 4]
  const cols: [number, number][] = [
    [-gap, -gap],
    [gap, -gap],
    [-gap, gap],
    [gap, gap],
  ]
  return (
    <group>
      {cols.map(([x, z], c) =>
        Array.from({ length: heights[c] }, (_, i) => (
          <group key={`${c}-${i}`} position={[x, i * step, z]} rotation={[0, (c % 2 ? 0.04 : -0.03) * (i + 1), 0]}>
            <TripoAsset kind="pallet" size={PALLET_SIZE}>
              <PalletMesh />
            </TripoAsset>
          </group>
        )),
      )}
    </group>
  )
}

function BarrierSegment({ x, z, rot }: { x: number; z: number; rot: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      <TripoAsset kind="barrier" size={BARRIER_SIZE}>
        <BarrierMesh />
      </TripoAsset>
    </group>
  )
}

/** Ring around the restricted bay, or a single barricade line across a route. */
function Barricade({ anchor }: { anchor: AnchorId }) {
  if (anchor === 'zone') {
    const half = 2.2
    return (
      <>
        {[-1.1, 1.1].flatMap((o) => [
          <BarrierSegment key={`n${o}`} x={o} z={-half} rot={0} />,
          <BarrierSegment key={`s${o}`} x={o} z={half} rot={0} />,
          <BarrierSegment key={`w${o}`} x={-half} z={o} rot={Math.PI / 2} />,
          <BarrierSegment key={`e${o}`} x={half} z={o} rot={Math.PI / 2} />,
        ])}
        <Cone position={[-half, 0, -half]} />
        <Cone position={[half, 0, half]} />
      </>
    )
  }
  // route runs along `axis`; the barricade spans the other axis
  const alongZ = ANCHORS[anchor].axis === 'z'
  const rot = alongZ ? 0 : Math.PI / 2
  const end = 1.5
  return (
    <>
      <BarrierSegment x={0} z={0} rot={rot} />
      <Cone position={alongZ ? [-end, 0, 0] : [0, 0, -end]} />
      <Cone position={alongZ ? [end, 0, 0] : [0, 0, end]} />
    </>
  )
}

function Hatch({ size, a, b, opacity }: { size: [number, number]; a: string; b: string; opacity: number }) {
  const tex = useStripes(a, b, size[0] / 1.2, size[1] / 1.2)
  return (
    <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={size} />
      <meshStandardMaterial map={tex} transparent opacity={opacity} depthWrite={false} />
    </mesh>
  )
}

function Strip({ position, size, color, opacity = 1 }: { position: Vec3; size: [number, number]; color: string; opacity?: number }) {
  return (
    <mesh position={position} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={size} />
      <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  )
}

function Crate({ position, size, color, onClick }: { position: Vec3; size: number; color: string; onClick: () => void }) {
  return (
    <Clickable enabled onClick={onClick}>
      <mesh position={[position[0], size / 2, position[2]]} castShadow receiveShadow>
        <boxGeometry args={[size, size, size]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
    </Clickable>
  )
}

function Drum({ position, color = '#c2413b' }: { position: Vec3; color?: string }) {
  return (
    <mesh position={[position[0], 0.5, position[2]]} castShadow>
      <cylinderGeometry args={[0.38, 0.38, 1, 20]} />
      <meshStandardMaterial color={color} roughness={0.5} metalness={0.3} />
    </mesh>
  )
}

function Marker({ kind, index, done, active, pos, onSelect }: { kind: Kind; index: number; done: boolean; active: boolean; pos: Vec3; onSelect: (k: Kind) => void }) {
  const body = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  const [hover, setHover] = useState(false)
  useCursor(hover)
  const color = done ? '#3ddc97' : AMBER
  useShowFrame((_, __, t) => {
    if (body.current) body.current.position.y = Math.sin(t * 2.2 + index) * 0.12
    if (ring.current) ring.current.scale.setScalar(1 + ((t * 0.8 + index * 0.3) % 1) * (done ? 0.2 : 0.9))
  })
  return (
    <group position={pos}>
      <mesh
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          onSelect(kind)
        }}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          setHover(true)
        }}
        onPointerOut={() => setHover(false)}
      >
        <sphereGeometry args={[0.95, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <group ref={body}>
        <mesh rotation={[Math.PI, 0, 0]} position={[0, -0.55, 0]} scale={hover || active ? 1.25 : 1}>
          <coneGeometry args={[0.3, 0.6, 4]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.4} />
        </mesh>
        <Html center position={[0, 0.2, 0]} className="no-pe" zIndexRange={[5, 0]}>
          <div className={`pin ${done ? 'pin-done' : ''} ${active ? 'pin-active' : ''}`}>{done ? '✓' : index + 1}</div>
        </Html>
      </group>
      <mesh ref={ring} position={[0, -pos[1] + 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.9, 1.0, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.65} depthWrite={false} />
      </mesh>
    </group>
  )
}

/** Dashed line that flows along its length. */
function FlowLine({ points, color, width, dashed = true, speed = 0.9, opacity = 1 }: { points: THREE.Vector3[]; color: string; width: number; dashed?: boolean; speed?: number; opacity?: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null)
  useShowFrame((_, dt) => {
    const m = ref.current?.material
    if (dashed && m) m.dashOffset -= dt * speed
  })
  return <Line ref={ref} points={points} color={color} lineWidth={width} dashed={dashed} dashSize={0.45} gapSize={0.3} transparent opacity={opacity} />
}

/** Arced, animated trail from an object's old position to its new one. */
function Trail({ from, to }: { from: Vec3; to: Vec3 }) {
  const pts = useMemo(() => {
    const a = new THREE.Vector3(from[0], 0.18, from[2])
    const b = new THREE.Vector3(to[0], 0.18, to[2])
    const mid = a.clone().lerp(b, 0.5)
    mid.y = 1.8
    return new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(48)
  }, [from, to])
  return (
    <>
      <FlowLine points={pts} color={AMBER} width={2.5} speed={1.1} />
      <mesh position={[to[0], 0.1, to[2]]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.35, 0.5, 24]} />
        <meshBasicMaterial color={AMBER} transparent opacity={0.9} depthWrite={false} />
      </mesh>
    </>
  )
}

const toV3 = (pts: [number, number][]) => pts.map(([x, z]) => new THREE.Vector3(x, 0.2, z))

/** A small light that travels along a route and stops where the route stops. */
function Walker({ path, stop, color, loop, runKey }: { path: [number, number][]; stop: number; color: string; loop: boolean; runKey: number }) {
  const ref = useRef<THREE.Group>(null)
  const t0 = useRef<number | null>(null)
  useEffect(() => {
    t0.current = null
  }, [runKey])
  useShowFrame((_, __, t) => {
    const g = ref.current
    if (!g) return
    if (t0.current === null) t0.current = t
    let el = t - t0.current
    if (loop) el %= stop / WALK_SPEED + 1.5
    const [x, z] = pointAt(path, Math.min(stop, el * WALK_SPEED))
    g.position.set(x, 0.6, z)
    g.scale.setScalar(1 + Math.sin(t * 8) * 0.1)
  })
  return (
    <group ref={ref} position={[path[0][0], 0.6, path[0][1]]}>
      <mesh>
        <sphereGeometry args={[0.32, 18, 18]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.4} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.45, 0]}>
        <ringGeometry args={[0.45, 0.6, 28]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} depthWrite={false} />
      </mesh>
    </group>
  )
}

/** One route drawn in the world: red up to the obstruction (then greyed out) or green end to end. */
function RouteTrace({ routeId, plan, loop, runKey, labels }: { routeId: RouteId; plan: WalkPlan; loop: boolean; runKey: number; labels: Dict }) {
  const route = ROUTES.find((r) => r.id === routeId)!
  const letter = routeId === 'west' ? 'A' : 'B'
  const { before, after } = useMemo(() => splitPath(route.path, plan.stop), [route, plan.stop])
  const stopAt = pointAt(route.path, plan.stop)
  const labelAt = pointAt(route.path, plan.total * 0.72)
  return (
    <group>
      {plan.blocked ? (
        <>
          {plan.stop > 0.4 && <FlowLine points={toV3(before)} color="#ff5a5f" width={5} speed={1.4} />}
          {plan.total - plan.stop > 0.4 && <FlowLine points={toV3(after)} color="#6b7690" width={2} speed={0} opacity={0.5} />}
          <group position={[stopAt[0], 0.12, stopAt[1]]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.55, 0.75, 32]} />
              <meshBasicMaterial color="#ff5a5f" transparent opacity={0.95} depthWrite={false} />
            </mesh>
          </group>
          <Tag text={`${letter} · ✕ ${labels.routeUnavailable}`} position={[stopAt[0], 1.5, stopAt[1]]} tone="red" />
          {plan.blockers.map((b) => {
            const p = ANCHORS[b.anchor].pos
            return (
              <group key={`${b.kind}${b.anchor}`} position={[p[0], 0, p[2]]}>
                <mesh position={[0, 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                  <ringGeometry args={[1.4, 1.6, 40]} />
                  <meshBasicMaterial color="#ff5a5f" transparent opacity={0.9} depthWrite={false} />
                </mesh>
                <Tag text={`✕ ${labels.kind[b.kind]}`} position={[0, 3.3, 0]} tone="red" />
              </group>
            )
          })}
        </>
      ) : (
        <>
          <FlowLine points={toV3(route.path)} color="#3ddc97" width={5} speed={2} />
          <Tag text={`${letter} · ✓ ${labels.routeAvailable}`} position={[labelAt[0], 1.3, labelAt[1]]} tone="green" />
        </>
      )}
      <Walker path={route.path} stop={plan.stop} color={plan.blocked ? '#ff5a5f' : '#3ddc97'} loop={loop} runKey={runKey} />
    </group>
  )
}

export interface RouteUi {
  /** off: hidden · reveal: both routes demonstrated (cinematic) · neutral: plain lines, the chosen one is walked */
  mode: 'off' | 'reveal' | 'neutral'
  chosen: RouteId | null
  walkKey: number
}

function RouteLines({ handover, shift, ui, labels }: { handover: Handover; shift: Shift; ui: RouteUi; labels: Dict }) {
  return (
    <>
      <Tag text={labels.entry} position={[-5, 0.3, -8.4]} tone="amber" />
      {ROUTES.map((r) => {
        const letter = r.id === 'west' ? 'A' : 'B'
        const pin = pointAt(r.path, 3.5)
        const traced = ui.mode === 'reveal' || ui.chosen === r.id
        const plan = walkPlan(handover, r.id, ui.mode === 'reveal' ? shift : 'current')
        return (
          <group key={r.id}>
            {traced ? (
              <RouteTrace routeId={r.id} plan={plan} loop={ui.mode === 'reveal'} runKey={ui.mode === 'reveal' ? 0 : ui.walkKey} labels={labels} />
            ) : (
              <FlowLine points={toV3(r.path)} color="#8fb2ff" width={3} speed={0.7} opacity={ui.chosen ? 0.3 : 0.9} />
            )}
            <Html position={[pin[0], 0.9, pin[1]]} center className="no-pe" zIndexRange={[5, 0]}>
              <div className={`route-pin ${traced ? (plan.blocked ? 'bad' : 'good') : ''}`}>{letter}</div>
            </Html>
          </group>
        )
      })}
    </>
  )
}

export interface Brief {
  kind: Kind
  title: string
  move: string
  note: string
  from: string
  why: string
  verify: string
}

/** The previous crew's briefing, attached to the changed object in 3D. */
function Briefing({ brief, anchor, labels }: { brief: Brief; anchor: AnchorId; labels: Dict }) {
  const camera = useThree((s) => s.camera)
  const p = ANCHORS[anchor].pos
  const pos: Vec3 = [p[0], MARKER_Y[brief.kind] - 0.3, p[2]]
  // decide once, when the card opens, which side of the object has room
  const [side] = useState<'left' | 'right'>(() => (new THREE.Vector3(...pos).project(camera).x < 0.12 ? 'right' : 'left'))
  return (
    <Html position={pos} className="no-pe" zIndexRange={[40, 20]}>
      <div className={`brief brief-${side}`}>
        <span className="brief-from">{labels.noteFrom(brief.from)}</span>
        <q>{brief.note}</q>
        <dl>
          <dt>{labels.briefWhat}</dt>
          <dd>
            <b>{brief.title}</b> · {brief.move}
          </dd>
          <dt>{labels.briefWhy}</dt>
          <dd>{brief.why}</dd>
          <dt className="verify">{labels.briefVerify}</dt>
          <dd>{brief.verify}</dd>
        </dl>
      </div>
    </Html>
  )
}

/** Clickable floor pads shown in Create mode for the selected object. */
function Pads({ handover, kind, labels, onPad }: { handover: Handover; kind: Kind; labels: Dict; onPad: (a: AnchorId) => void }) {
  return (
    <>
      {ALLOWED[kind].map((a) => (
        <Pad
          key={a}
          anchor={a}
          selected={handover.changes[kind]?.after === a}
          free={canPlace(handover, kind, a)}
          label={labels.anchor[a]}
          onPad={onPad}
        />
      ))}
    </>
  )
}

function Pad({ anchor, selected, free, label, onPad }: { anchor: AnchorId; selected: boolean; free: boolean; label: string; onPad: (a: AnchorId) => void }) {
  const ref = useRef<THREE.Mesh>(null)
  const [hover, setHover] = useState(false)
  useCursor(hover && free)
  const p = ANCHORS[anchor].pos
  useShowFrame((_, __, t) => {
    if (ref.current && free && !selected) ref.current.scale.setScalar(1 + Math.sin(t * 3) * 0.04)
  })
  const color = selected ? AMBER : free ? '#5ec8ff' : '#4a5468'
  return (
    <group position={[p[0], 0.06, p[2]]}>
      <mesh
        ref={ref}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          if (free) onPad(anchor)
        }}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          setHover(true)
        }}
        onPointerOut={() => setHover(false)}
      >
        <cylinderGeometry args={[1.25, 1.25, 0.06, 40]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.55 : hover && free ? 0.5 : free ? 0.28 : 0.15} depthWrite={false} />
      </mesh>
      <Tag text={label} position={TAG_AT[anchor].map((v, i) => (i === 1 ? 0.5 : v)) as Vec3} tone={selected ? 'amber' : 'neutral'} />
    </group>
  )
}

function CameraRig({ focus, resetKey }: { focus: Vec3; resetKey: number }) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null
  const camera = useThree((s) => s.camera)
  const goal = useRef(new THREE.Vector3())
  const aspect = useThree((s) => s.size.width / s.size.height)
  useEffect(() => {
    goal.current.set(...focus)
  }, [focus])
  // Explicit framing: fit the whole worksite (≈ ±14.5 wide, ±8.8 tall on screen) for any aspect ratio.
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))
    const dist = THREE.MathUtils.clamp(Math.max(8.8 / tanHalf, 14.5 / (tanHalf * aspect)), 22, 40)
    camera.position.copy(HOME_DIR).multiplyScalar(dist)
    goal.current.set(...ORIGIN)
  }, [resetKey, aspect, camera])
  useShowFrame((_, dt) => {
    if (!controls) return
    controls.target.lerp(goal.current, 1 - Math.exp(-4 * dt))
    controls.update()
  })
  return null
}

// ---------- world ------------------------------------------------------------
export interface SceneProps {
  handover: Handover
  shift: Shift
  mode: 'receive' | 'create'
  /** kinds that show a marker (receive: all changes; create: the selected object) */
  markers: Kind[]
  found: Kind[]
  focus: Kind | null
  resetKey: number
  intro: boolean
  selectedKind: Kind | null
  routeUi: RouteUi
  /** amber "what happened here" tags over the changed objects (cinematic) */
  callouts: boolean
  brief: Brief | null
  onSelect: (k: Kind) => void
  onPad: (a: AnchorId) => void
  onDecoy: () => void
  t: Dict
}

const machineYaw = (a: AnchorId) => (a === 'parking' ? -0.5 : ANCHORS[a].axis === 'z' ? Math.PI / 2 : 0)

function World({ handover, shift, mode, markers, found, focus, resetKey, intro, selectedKind, routeUi, callouts, brief, onSelect, onPad, onDecoy, t }: SceneProps) {
  useShowClockTick()
  const current = shift === 'current'
  const create = mode === 'create'
  const occ = useMemo(() => occupancy(handover, 'current'), [handover])
  const at = (k: Kind) => placeOf(handover, k, shift)
  const enabled = (k: Kind) => create || (current && !!handover.changes[k])

  return (
    <>
      <color attach="background" args={['#0a101c']} />
      <fog attach="fog" args={['#0a101c', 32, 70]} />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={['#9db4ff', '#2a2018', 0.55]} />
      <directionalLight
        position={[10, 16, 8]}
        intensity={2.1}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-17}
        shadow-camera-right={17}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-camera-far={50}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-9, 6, -5]} intensity={0.5} color="#ffcf8a" />
      <pointLight position={[5, 3.2, -3.5]} color={AMBER} intensity={occ.get('zone') ? 22 : 6} distance={9} />

      {/* ground */}
      <mesh position={[0, -0.16, 0]} receiveShadow>
        <boxGeometry args={[27, 0.3, 18.6]} />
        <meshStandardMaterial color="#161e2e" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.32, 0]}>
        <planeGeometry args={[140, 140]} />
        <meshStandardMaterial color="#080c15" />
      </mesh>
      <Grid
        position={[0, 0.006, 0]}
        args={[27, 18.6]}
        cellSize={1}
        sectionSize={5}
        cellThickness={0.6}
        sectionThickness={1.1}
        cellColor="#243049"
        sectionColor="#3a4a6b"
        fadeDistance={70}
        fadeStrength={0}
      />
      {[
        [0, -9, 26.6, 0.12],
        [0, 9, 26.6, 0.12],
        [-13.3, 0, 0.12, 18],
        [13.3, 0, 0.12, 18],
      ].map(([x, z, w, d]) => (
        <Strip key={`${x}${z}`} position={[x, 0.02, z]} size={[w, d]} color={AMBER} opacity={0.8} />
      ))}

      {/* back wall + columns + racks + cabinet */}
      <mesh position={[0, 1.75, -9.4]} castShadow receiveShadow>
        <boxGeometry args={[27, 3.5, 0.3]} />
        <meshStandardMaterial color="#1a2436" roughness={0.9} />
      </mesh>
      {[-9.7, -3.2, 3.3, 9.8].map((x) => (
        <mesh key={x} position={[x, 1.75, -9.1]} castShadow>
          <boxGeometry args={[0.5, 3.5, 0.5]} />
          <meshStandardMaterial color="#26324a" />
        </mesh>
      ))}
      {[-8, -0.3].map((x) => (
        <group key={x} position={[x, 0, -8.55]}>
          <TripoAsset kind="rack" size={RACK_SIZE}>
            <RackMesh />
          </TripoAsset>
        </group>
      ))}
      <Clickable enabled onClick={onDecoy}>
        <group position={[9, 0, -8.7]}>
          <TripoAsset kind="cabinet" size={CABINET_SIZE}>
            <CabinetMesh />
          </TripoAsset>
        </group>
      </Clickable>

      {/* route surfaces: walkway, Bay B lane, north + east aisles */}
      <Strip position={[-5, 0.015, 0]} size={[2, 16.4]} color="#1d6b57" opacity={0.55} />
      {[-1, 1].map((s) => (
        <Strip key={s} position={[-5 + s * 1, 0.025, 0]} size={[0.1, 16.4]} color="#f2f2ec" />
      ))}
      {Array.from({ length: 8 }, (_, i) => (
        <Strip key={i} position={[-5, 0.025, -7 + i * 2]} size={[0.14, 0.9]} color="#9be8c8" opacity={0.9} />
      ))}
      <Strip position={[3, 0.015, 4]} size={[13, 2.2]} color="#232d42" />
      {Array.from({ length: 6 }, (_, i) => (
        <Strip key={i} position={[-2.2 + i * 2.2, 0.025, 4]} size={[1.1, 0.14]} color={AMBER} opacity={0.85} />
      ))}
      <Strip position={[2.9, 0.015, -7.1]} size={[15.8, 1.8]} color="#232d42" />
      {Array.from({ length: 7 }, (_, i) => (
        <Strip key={i} position={[-3.4 + i * 2.2, 0.025, -7.1]} size={[1.1, 0.12]} color={AMBER} opacity={0.7} />
      ))}
      <Strip position={[10.8, 0.015, -1.55]} size={[1.8, 11.1]} color="#232d42" />
      {Array.from({ length: 5 }, (_, i) => (
        <Strip key={i} position={[10.8, 0.025, -6 + i * 2.2]} size={[0.12, 1.1]} color={AMBER} opacity={0.7} />
      ))}
      <Tag text={t.walkway} position={TAG_AT.walkway} />
      <Tag text={t.anchor.northAisle} position={TAG_AT.northAisle} />
      <Tag text={t.anchor.eastAisle} position={TAG_AT.eastAisle} />

      {/* Bay B door */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[9.9, 1.2, 4 + s * 1.3]} castShadow>
          <boxGeometry args={[0.2, 2.4, 0.2]} />
          <meshStandardMaterial color={AMBER} />
        </mesh>
      ))}
      <mesh position={[9.9, 2.45, 4]} castShadow>
        <boxGeometry args={[0.25, 0.25, 2.8]} />
        <meshStandardMaterial color={AMBER} />
      </mesh>
      <Tag text={t.bay} position={[9.9, 3.1, 4]} tone="amber" />

      {/* rest spots: storage + machine parking */}
      <Strip position={[ANCHORS.storage.pos[0], 0.02, ANCHORS.storage.pos[2]]} size={[3.2, 3.2]} color="#2d3a55" opacity={0.7} />
      <Tag text={t.anchor.storage} position={TAG_AT.storage} />
      <Strip position={[ANCHORS.parking.pos[0], 0.02, ANCHORS.parking.pos[2]]} size={[3.8, 2.8]} color="#2d3a55" opacity={0.7} />
      <Tag text={t.anchor.parking} position={TAG_AT.parking} />
      <Cone position={[-10.7, 0, -0.6]} />
      <Cone position={[-7.3, 0, -3.5]} />
      <Cone position={[5.2, 0, 2.2]} />
      <Cone position={[8.9, 0, -0.9]} />

      {/* restricted bay: floor, drums */}
      <Strip position={[5, 0.02, -3.5]} size={[4.4, 4.4]} color="#3a1f22" opacity={0.7} />
      {[
        [0, -2.2, 4.4, 0.1],
        [0, 2.2, 4.4, 0.1],
        [-2.2, 0, 0.1, 4.4],
        [2.2, 0, 0.1, 4.4],
      ].map(([x, z, w, d]) => (
        <Strip key={`${x}${z}`} position={[5 + x, 0.03, -3.5 + z]} size={[w, d]} color="#e5484d" />
      ))}
      <Drum position={[4.3, 0, -3.9]} />
      <Drum position={[5.2, 0, -4.2]} />
      <Drum position={[5.6, 0, -3.1]} color="#d8832a" />
      <mesh position={[4.2, 0.45, -2.7]} castShadow>
        <boxGeometry args={[1.1, 0.9, 0.8]} />
        <meshStandardMaterial color="#2b3446" metalness={0.4} roughness={0.5} />
      </mesh>
      <Tag text={t.restricted} position={TAG_AT.zone} tone="amber" />

      {/* red hatch under anything that sits on a route (current shift) */}
      {ROUTE_ANCHORS.map((a) => {
        const p = ANCHORS[a].pos
        const alongX = ANCHORS[a].axis === 'x'
        return (
          <Pop key={a} show={current && occ.has(a)} position={[p[0], 0, p[2]]}>
            <Hatch size={alongX ? [3.6, 2.2] : [2.2, 3.6]} a="#e5484d" b="#1a2030" opacity={0.6} />
          </Pop>
        )
      })}

      {/* the three movable objects: rewind/forward glides them between anchors */}
      <Mover at={at('pallet')}>
        <Clickable enabled={enabled('pallet')} onClick={() => onSelect('pallet')}>
          <PalletStack />
        </Clickable>
      </Mover>
      <Mover key={`barrier-${at('barrier')}`} at={at('barrier')} appear>
        <Clickable enabled={enabled('barrier')} onClick={() => onSelect('barrier')}>
          {at('barrier') ? <Barricade anchor={at('barrier')!} /> : null}
        </Clickable>
      </Mover>
      <Mover at={at('machine')} rot={machineYaw}>
        <Clickable enabled={enabled('machine')} onClick={() => onSelect('machine')}>
          <TripoAsset kind="machine" size={MACHINE_SIZE}>
            <MachineMesh />
          </TripoAsset>
        </Clickable>
      </Mover>

      {/* ghosts + trails: where things used to be, and how they moved */}
      {KINDS.map((k) => {
        const from = BASE[k]
        const to = handover.changes[k]?.after
        if (!from || !to) return null
        const size: Vec3 = k === 'machine' ? [3, 2, 2] : [2.4, 1.2, 2.4]
        const p = ANCHORS[from].pos
        return (
          <group key={k}>
            <Pop show={current} position={[p[0], size[1] / 2, p[2]]}>
              <mesh>
                <boxGeometry args={size} />
                <meshBasicMaterial color={AMBER} wireframe transparent opacity={0.3} />
              </mesh>
            </Pop>
            {current && <Trail from={p} to={ANCHORS[to].pos} />}
          </group>
        )
      })}

      {/* unchanged props (decoys) */}
      <Crate position={[-1.6, 0, -5.4]} size={1.1} color="#5c4a38" onClick={onDecoy} />
      <Crate position={[-0.3, 0, -5.8]} size={0.75} color="#6d5a45" onClick={onDecoy} />
      <Crate position={[1.8, 0, -5.2]} size={1.3} color="#4f3f31" onClick={onDecoy} />
      <Crate position={[-9, 0, 3]} size={1.2} color="#5c4a38" onClick={onDecoy} />
      <Crate position={[-9.2, 0, 4.4]} size={0.8} color="#6d5a45" onClick={onDecoy} />
      <Clickable enabled onClick={onDecoy}>
        <Drum position={[-9.6, 0, -6]} color="#2f6fb0" />
        <Drum position={[-8.8, 0, -6.6]} color="#2f6fb0" />
      </Clickable>

      {/* markers */}
      {current &&
        markers.map((k, i) => {
          const a = placeOf(handover, k, 'current')
          if (!a) return null
          const p = ANCHORS[a].pos
          return (
            <Marker key={k} kind={k} index={i} done={!create && found.includes(k)} active={focus === k || selectedKind === k} pos={[p[0], MARKER_Y[k], p[2]]} onSelect={onSelect} />
          )
        })}

      {callouts &&
        KINDS.map((k) => {
          const a = placeOf(handover, k, 'current')
          if (!a || !handover.changes[k]) return null
          const p = ANCHORS[a].pos
          return <Tag key={k} text={t.callout[k]} position={[p[0], MARKER_Y[k] - 0.2, p[2]]} tone="amber" />
        })}

      {brief && current && (() => {
        const a = placeOf(handover, brief.kind, 'current')
        return a ? <Briefing key={brief.kind} brief={brief} anchor={a} labels={t} /> : null
      })()}

      {create && selectedKind && <Pads handover={handover} kind={selectedKind} labels={t} onPad={onPad} />}
      {!create && routeUi.mode !== 'off' && <RouteLines handover={handover} shift={shift} ui={routeUi} labels={t} />}

      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        minDistance={10}
        maxDistance={46}
        minPolarAngle={0.35}
        maxPolarAngle={1.35}
        autoRotate={intro}
        autoRotateSpeed={0.5}
      />
      <CameraRig focus={ORIGIN} resetKey={resetKey} />
    </>
  )
}

export function Scene(props: SceneProps) {
  return (
    <Canvas shadows dpr={[1, 1.5]} camera={{ position: [14.5, 12.5, 15.5], fov: 36, near: 0.1, far: 220 }} onCreated={() => performance.mark('sz-canvas')}>
      <World {...props} />
    </Canvas>
  )
}
