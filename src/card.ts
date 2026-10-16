export interface CardData {
  eyebrow: string
  title: string
  sub: string
  rows: [string, string][]
  chips: string[]
  footer: string
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number, maxLines: number) {
  const words = text.split(/(\s+)/)
  let line = ''
  let lines = 0
  for (const w of words) {
    if (ctx.measureText(line + w).width > maxW && line.trim()) {
      ctx.fillText(line.trim(), x, y + lines * lineH)
      lines++
      line = w.trimStart()
      if (lines >= maxLines) return y + lines * lineH
    } else line += w
  }
  if (line.trim()) ctx.fillText(line.trim(), x, y + lines * lineH)
  return y + (lines + 1) * lineH
}

/** Draws the "Gift of Understanding" result card to a PNG and downloads it. Pure canvas, no network. */
export function downloadCard(c: CardData) {
  const cv = document.createElement('canvas')
  cv.width = 1200
  cv.height = 630
  const ctx = cv.getContext('2d')!
  const sans = '"Inter", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif'
  const head = '"Space Grotesk", "Inter", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif'

  const g = ctx.createLinearGradient(0, 0, 1200, 630)
  g.addColorStop(0, '#0a0f1a')
  g.addColorStop(1, '#18233f')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 1200, 630)
  ctx.fillStyle = '#f5a524'
  ctx.fillRect(0, 0, 14, 630)

  ctx.fillStyle = '#f5a524'
  ctx.font = `700 22px ${sans}`
  ctx.fillText(c.eyebrow.toUpperCase(), 70, 90)

  ctx.fillStyle = '#e9eef7'
  ctx.font = `700 68px ${head}`
  ctx.fillText(c.title, 70, 175)

  ctx.fillStyle = '#9aa6bf'
  ctx.font = `400 28px ${sans}`
  const y = wrap(ctx, c.sub, 70, 230, 1000, 38, 2)

  let ry = y + 30
  for (const [k, v] of c.rows) {
    ctx.fillStyle = '#8f9bb3'
    ctx.font = `600 20px ${sans}`
    ctx.fillText(k.toUpperCase(), 70, ry)
    ctx.fillStyle = '#e9eef7'
    ctx.font = `600 28px ${sans}`
    ctx.fillText(v, 330, ry + 2)
    ry += 46
  }

  let cx = 70
  const cy = 530
  ctx.font = `600 20px ${sans}`
  for (const chip of c.chips) {
    const w = ctx.measureText(chip).width + 36
    if (cx + w > 1130) break
    ctx.fillStyle = 'rgba(245,165,36,0.14)'
    ctx.strokeStyle = 'rgba(245,165,36,0.5)'
    ctx.beginPath()
    ctx.roundRect(cx, cy - 28, w, 44, 22)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#ffd08a'
    ctx.fillText(chip, cx + 18, cy + 2)
    cx += w + 12
  }

  ctx.fillStyle = '#8f9bb3'
  ctx.font = `400 18px ${sans}`
  wrap(ctx, c.footer, 70, 584, 1060, 24, 2)

  cv.toBlob((blob) => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'shift-zero-gift-of-understanding.png'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }, 'image/png')
}
