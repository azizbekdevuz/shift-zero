import { useFrame, type RootState } from '@react-three/fiber'

/**
 * One shared logical animation clock for everything that moves in the 3D showcase.
 * `t` only advances while not frozen, and each frame's delta is capped, so a paused showcase is truly
 * still and resuming (or returning to a suspended tab) never causes a jump.
 * `frozen` is only ever set while the presenter has the cinematic paused.
 */
export const showClock = { frozen: false, t: 0 }

const MAX_DT = 0.1

/** Mount once inside the Canvas. Runs before every other frame callback. */
export function useShowClockTick() {
  useFrame((_, dt) => {
    if (!showClock.frozen) showClock.t += Math.min(dt, MAX_DT)
  }, -100)
}

/** Drop-in `useFrame` for showcase animation: delta is 0 while frozen, and `t` is the shared clock. */
export function useShowFrame(cb: (state: RootState, dt: number, t: number) => void) {
  useFrame((state, dt) => cb(state, showClock.frozen ? 0 : Math.min(dt, MAX_DT), showClock.t))
}
