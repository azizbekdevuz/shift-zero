// Non-destructive texture downscale for the Tripo GLBs in public/models.
//
// Why: every GLB carries one 8192x8192 JPEG base-colour texture (5-8 MB each, ~256 MB uncompressed in
// memory, per model). Geometry is only ~10k triangles. Decoding + uploading six 8192² textures froze the
// page for seconds. This script resizes the embedded texture to MAX_TEX (default 2048) and re-packs the
// GLB. Mesh, UVs, material and texture are otherwise untouched, so the look is the same.
//
// - Originals are copied once to assets-original/models/ and ALWAYS used as the source, so re-running is
//   idempotent and can never compress an already-compressed file.
// - Uses only Node + Windows PowerShell's built-in System.Drawing (no new dependencies).
//
// Usage:  node scripts/shrink-glb-textures.mjs            (MAX_TEX=1024 node ... to go smaller)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const MAX = Number(process.env.MAX_TEX || 2048)
const QUALITY = Number(process.env.JPEG_QUALITY || 90)
const OUT_DIR = 'public/models'
const BACKUP_DIR = 'assets-original/models'

fs.mkdirSync(BACKUP_DIR, { recursive: true })
const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.glb'))
if (!files.length) throw new Error('no GLBs in ' + OUT_DIR)

// 1. back up originals (never overwrite an existing backup)
for (const f of files) {
  const dst = path.join(BACKUP_DIR, f)
  if (!fs.existsSync(dst)) fs.copyFileSync(path.join(OUT_DIR, f), dst)
}

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB')
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const binLen = buf.readUInt32LE(20 + jsonLen)
  const bin = buf.subarray(28 + jsonLen, 28 + jsonLen + binLen)
  return { json, bin }
}

// 2. extract embedded images from the ORIGINALS
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shiftzero-tex-'))
const inDir = path.join(tmp, 'in')
const outDir = path.join(tmp, 'out')
fs.mkdirSync(inDir)
fs.mkdirSync(outDir)
const parsed = {}
for (const f of files) {
  const { json, bin } = parseGlb(fs.readFileSync(path.join(BACKUP_DIR, f)))
  parsed[f] = { json, bin }
  ;(json.images || []).forEach((img, i) => {
    if (img.bufferView === undefined) return
    const v = json.bufferViews[img.bufferView]
    const off = v.byteOffset || 0
    fs.writeFileSync(path.join(inDir, `${f}__${i}.img`), bin.subarray(off, off + v.byteLength))
  })
}

// 3. resize with System.Drawing (one PowerShell start for all images)
const ps1 = path.join(tmp, 'resize.ps1')
fs.writeFileSync(
  ps1,
  `param([string]$In,[string]$Out,[int]$Max,[int]$Q)
Add-Type -AssemblyName System.Drawing
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Q)
Get-ChildItem $In | ForEach-Object {
  $src = [System.Drawing.Image]::FromFile($_.FullName)
  $big = [Math]::Max($src.Width, $src.Height)
  $k = [Math]::Min(1.0, $Max / $big)
  $w = [int][Math]::Round($src.Width * $k); $h = [int][Math]::Round($src.Height * $k)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $w, $h)
  $bmp.Save((Join-Path $Out ($_.BaseName + '.jpg')), $codec, $ep)
  $g.Dispose(); $bmp.Dispose(); $src.Dispose()
  Write-Output ($_.Name + ' -> ' + $w + 'x' + $h)
}
`,
)
console.log(
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-In', inDir, '-Out', outDir, '-Max', String(MAX), '-Q', String(QUALITY)], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  }),
)

// 4. rebuild each GLB with the resized texture (bufferViews re-packed, 4-byte aligned)
const pad4 = (n) => (n + 3) & ~3
for (const f of files) {
  const { json, bin } = parsed[f]
  const replace = new Map() // bufferView index -> Buffer
  ;(json.images || []).forEach((img, i) => {
    if (img.bufferView === undefined) return
    replace.set(img.bufferView, fs.readFileSync(path.join(outDir, `${f}__${i}.jpg`)))
    img.mimeType = 'image/jpeg'
  })
  const order = json.bufferViews.map((v, i) => i).sort((a, b) => (json.bufferViews[a].byteOffset || 0) - (json.bufferViews[b].byteOffset || 0))
  const parts = []
  let pos = 0
  for (const i of order) {
    const v = json.bufferViews[i]
    const data = replace.get(i) ?? bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength)
    const aligned = pad4(pos)
    if (aligned > pos) parts.push(Buffer.alloc(aligned - pos))
    parts.push(data)
    v.byteOffset = aligned
    v.byteLength = data.length
    pos = aligned + data.length
  }
  const binLen = pad4(pos)
  if (binLen > pos) parts.push(Buffer.alloc(binLen - pos))
  json.buffers[0].byteLength = pos
  delete json.buffers[0].uri
  const newBin = Buffer.concat(parts)
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)])
  const total = 12 + 8 + jsonBuf.length + 8 + newBin.length
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x46546c67, 0)
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(total, 8)
  const jh = Buffer.alloc(8)
  jh.writeUInt32LE(jsonBuf.length, 0)
  jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8)
  bh.writeUInt32LE(newBin.length, 0)
  bh.writeUInt32LE(0x004e4942, 4)
  fs.writeFileSync(path.join(OUT_DIR, f), Buffer.concat([head, jh, jsonBuf, bh, newBin]))
  const before = fs.statSync(path.join(BACKUP_DIR, f)).size
  console.log(`${f}: ${(before / 1e6).toFixed(2)} MB -> ${(total / 1e6).toFixed(2)} MB`)
}
fs.rmSync(tmp, { recursive: true, force: true })
