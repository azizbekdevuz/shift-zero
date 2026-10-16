import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'

export type AssetKind = 'pallet' | 'barrier' | 'machine' | 'cone' | 'rack' | 'cabinet'
export type AssetStatus = 'checking' | 'procedural' | 'glb'
export type Size3 = readonly [number, number, number]

export const ASSET_KINDS: AssetKind[] = ['pallet', 'barrier', 'machine', 'cone', 'rack', 'cabinet']

/**
 * Credit flag. true = the team declares the GLBs in public/models were pre-generated in Tripo Studio
 * (the Sources panel then says so, and always says no live Tripo API is called).
 * Set to false if any of them did not come from Tripo. The app cannot verify provenance itself.
 */
export const TEAM_DECLARED_TRIPO = true

/** Yaw (radians) that aligns a GLB's long axis with our procedural fallback (long axis = +X). */
const GLB_YAW: Partial<Record<AssetKind, number>> = { machine: Math.PI / 2, cabinet: Math.PI / 2 }

/** Tiny decorative pieces don't cast shadows (not noticeable, and it saves a shadow-pass draw each). */
const NO_SHADOW = new Set<AssetKind>(['cone'])

/** File name (without .glb) in public/models for each kind. */
const MODEL_FILE: Record<AssetKind, string> = {
  pallet: 'pallet',
  barrier: 'barrier',
  machine: 'machine',
  cone: 'cone',
  rack: 'storage-rack',
  cabinet: 'tool-cabinet',
}
export const modelFile = (kind: AssetKind) => `${MODEL_FILE[kind]}.glb`
const modelUrl = (kind: AssetKind) => `${import.meta.env.BASE_URL}models/${modelFile(kind)}`
// Draco decoder is served locally (public/draco/gltf) so compressed GLBs also load offline.
const DRACO_PATH = `${import.meta.env.BASE_URL}draco/gltf/`

// Hero objects first, so the most visible models appear first.
const LOAD_ORDER: AssetKind[] = ['pallet', 'machine', 'barrier', 'cone', 'rack', 'cabinet']

// --- One loader, one request per file --------------------------------------
// Each GLB is requested exactly once, by the real loader. The status shown in the UI is the outcome of
// that request: parsed OK → 'glb'; network error or not a valid GLB (the dev server answers a missing
// file with index.html) → 'procedural'. There is no separate "probe" download.
let snapshot = Object.fromEntries(ASSET_KINDS.map((k) => [k, 'checking'])) as Record<AssetKind, AssetStatus>
const listeners = new Set<() => void>()

function setStatus(kind: AssetKind, status: AssetStatus) {
  if (snapshot[kind] === status) return
  snapshot = { ...snapshot, [kind]: status }
  listeners.forEach((l) => l())
  if (ASSET_KINDS.every((k) => snapshot[k] !== 'checking')) performance.mark('sz-models-settled')
}

interface Prepared {
  /** yawed model; clones share geometry + materials */
  object: THREE.Object3D
  size: THREE.Vector3
  center: THREE.Vector3
  minY: number
}
const prepared = new Map<AssetKind, Prepared>()

/** Done once per model: shadow flags, yaw and the (expensive, precise) bounding box. */
function prepare(kind: AssetKind, scene: THREE.Object3D): Prepared {
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = !NO_SHADOW.has(kind)
      o.receiveShadow = true
    }
  })
  const object = new THREE.Group()
  object.add(scene)
  object.rotation.y = GLB_YAW[kind] ?? 0
  object.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(object, true)
  return { object, size: box.getSize(new THREE.Vector3()), center: box.getCenter(new THREE.Vector3()), minY: box.min.y }
}

const nextTask = () => new Promise<void>((r) => setTimeout(r, 0))

let started = false
async function loadAll() {
  if (started) return
  started = true
  const draco = new DRACOLoader().setDecoderPath(DRACO_PATH)
  const loader = new GLTFLoader().setDRACOLoader(draco)
  // all six requests go out together (one request each)…
  const pending = LOAD_ORDER.map((kind) =>
    loader.loadAsync(modelUrl(kind)).then(
      (gltf) => gltf,
      () => null,
    ),
  )
  // …and are swapped in one by one, hero objects first, yielding between each so the page stays responsive
  for (let i = 0; i < LOAD_ORDER.length; i++) {
    const kind = LOAD_ORDER[i]
    const gltf = await pending[i]
    try {
      if (!gltf) throw new Error('load failed')
      prepared.set(kind, prepare(kind, gltf.scene))
      setStatus(kind, 'glb')
    } catch {
      setStatus(kind, 'procedural')
    }
    await nextTask()
  }
  draco.dispose()
}
// start fetching as soon as this module is evaluated, before React has mounted anything
void loadAll()

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export function useAssetStatuses() {
  return useSyncExternalStore(subscribe, () => snapshot)
}

// --- Fit: uniform scale + centre/floor offset, cached per model and size ----
const fits = new Map<string, { scale: number; offset: THREE.Vector3 }>()
function fitOf(kind: AssetKind, size: Size3) {
  const key = `${kind}:${size.join(',')}`
  let fit = fits.get(key)
  if (!fit) {
    const p = prepared.get(kind)!
    const ratios = [size[0] / p.size.x, size[1] / p.size.y, size[2] / p.size.z].filter((r) => Number.isFinite(r) && r > 0)
    fit = { scale: ratios.length ? Math.min(...ratios) : 1, offset: new THREE.Vector3(-p.center.x, -p.minY, -p.center.z) }
    fits.set(key, fit)
  }
  return fit
}

/**
 * Hierarchy: <group scale=s> → <group position=-(centre, floor)> → yawed model.
 * The inner offset is in the model's own (unscaled) units, so the outer uniform scale fits the
 * model into `size`, and the result is centred on x/z with its base on y=0.
 * Instances are cheap clones of one shared, already-prepared model.
 */
function GlbModel({ kind, size }: { kind: AssetKind; size: Size3 }) {
  const { scale, offset } = fitOf(kind, size)
  const object = useMemo(() => prepared.get(kind)!.object.clone(), [kind])
  return (
    <group scale={scale}>
      <group position={offset}>
        <primitive object={object} />
      </group>
    </group>
  )
}

/**
 * Renders public/models/<kind>.glb (fitted to `size`) once it has actually loaded.
 * Until then — and permanently if it fails — it renders the procedural `children`,
 * so the scene is never blank and never depends on a GLB being present.
 */
export function TripoAsset({ kind, size, children }: { kind: AssetKind; size: Size3; children: ReactNode }) {
  const status = useAssetStatuses()[kind]
  if (status !== 'glb') return <>{children}</>
  return <GlbModel kind={kind} size={size} />
}