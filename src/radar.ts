// Shared radar/spider chart SVG helpers

function toPoints(values: number[], cx: number, cy: number, maxR: number): string {
  const n = values.length
  return values.map((v, i) => {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2
    const r = Math.min(Math.max(v, 0), 1) * maxR
    return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`
  }).join(' ')
}

function gridRing(fraction: number, n: number, cx: number, cy: number, maxR: number): string {
  return toPoints(Array(n).fill(fraction), cx, cy, maxR)
}

function buildSvgBase(axes: string[], cx: number, cy: number, maxR: number, labelR: number): string {
  const n = axes.length

  const grid = [0.25, 0.5, 0.75, 1].map(f =>
    `<polygon points="${gridRing(f, n, cx, cy, maxR)}" class="radar-grid"/>`,
  ).join('')

  const axisLines = Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2
    const x = (cx + maxR * Math.cos(angle)).toFixed(1)
    const y = (cy + maxR * Math.sin(angle)).toFixed(1)
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="radar-axis"/>`
  }).join('')

  const labels = axes.map((label, i) => {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2
    const x = (cx + labelR * Math.cos(angle)).toFixed(1)
    const y = (cy + labelR * Math.sin(angle)).toFixed(1)
    const cos = Math.cos(angle)
    const anchor = cos > 0.1 ? 'start' : cos < -0.1 ? 'end' : 'middle'
    const display = label.length > 10 ? label.slice(0, 9) + '…' : label
    return `<text x="${x}" y="${y}" class="radar-label" text-anchor="${anchor}" dominant-baseline="middle">${display}</text>`
  }).join('')

  return grid + axisLines + labels
}

// Static single-series radar — used on home card
export function radarSvg(axes: string[], values: number[], w = 150, h = 150): string {
  const cx = w / 2, cy = h / 2
  const maxR = Math.min(cx, cy) - 22
  const base = buildSvgBase(axes, cx, cy, maxR, maxR + 13)
  const shape = `<polygon points="${toPoints(values, cx, cy, maxR)}" class="radar-shape"/>`
  return `<svg class="radar-chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" overflow="visible" xmlns="http://www.w3.org/2000/svg">${base}${shape}</svg>`
}

// Multi-series radar with a static average shape and hidden per-run polygons
// Polygons are toggled externally by data-run-id
export function historyRadarSvg(
  axes: string[],
  avgValues: number[],
  runs: Array<{ id: number; values: number[] }>,
  w = 210, h = 210,
): string {
  const cx = w / 2, cy = h / 2
  const maxR = Math.min(cx, cy) - 26
  const base = buildSvgBase(axes, cx, cy, maxR, maxR + 15)
  const avg = `<polygon points="${toPoints(avgValues, cx, cy, maxR)}" class="radar-avg"/>`
  const runPolys = runs.map(({ id, values }) =>
    `<polygon points="${toPoints(values, cx, cy, maxR)}" class="radar-run" data-run-id="${id}" style="display:none"/>`,
  ).join('')
  return `<svg class="history-radar" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" overflow="visible" xmlns="http://www.w3.org/2000/svg">${base}${avg}${runPolys}</svg>`
}
