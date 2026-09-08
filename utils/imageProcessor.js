/**
 * 图像处理模块：网格自动检测 + 颜色提取聚类
 * 针对十字绣/拼豆图纸：图上有规律网格线（每格细线、每10格粗线）
 */

/**
 * 分析一个方向上的暗度投影，找出网格线的间距与偏移
 * @param {Float32Array} proj 每个像素位置的暗度累加值
 * @returns {{gap:number, offset:number}|null}
 */
function analyzeProjection(proj) {
  const n = proj.length
  let max = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += proj[i]
    if (proj[i] > max) max = proj[i]
  }
  const mean = sum / n
  if (max <= mean) return null
  const threshold = mean + (max - mean) * 0.35

  // 找局部峰值（网格线位置）
  const peaks = []
  for (let i = 1; i < n - 1; i++) {
    if (proj[i] >= threshold && proj[i] >= proj[i - 1] && proj[i] >= proj[i + 1]) {
      const last = peaks.length - 1
      if (last >= 0 && i - peaks[last] < 3) {
        if (proj[i] > proj[peaks[last]]) peaks[last] = i
      } else {
        peaks.push(i)
      }
    }
  }
  if (peaks.length < 4) return null

  // 统计相邻峰值的间隔，众数即为单元格尺寸
  const hist = new Map()
  for (let i = 1; i < peaks.length; i++) {
    const gap = peaks[i] - peaks[i - 1]
    if (gap >= 3 && gap <= 200) {
      hist.set(gap, (hist.get(gap) || 0) + 1)
    }
  }
  if (!hist.size) return null
  let bestGap = 0
  let bestCount = 0
  hist.forEach((count, gap) => {
    if (count > bestCount || (count === bestCount && gap < bestGap)) {
      bestCount = count
      bestGap = gap
    }
  })
  if (bestGap < 3) return null

  // 用所有峰值对齐求偏移
  let offsetSum = 0
  for (const p of peaks) {
    const k = Math.round(p / bestGap)
    offsetSum += p - k * bestGap
  }
  let offset = Math.round(offsetSum / peaks.length)
  offset = ((offset % bestGap) + bestGap) % bestGap
  return { gap: bestGap, offset }
}

/**
 * 自动检测图纸网格
 * @param {ImageData} imageData
 * @returns {{cellW:number, cellH:number, offsetX:number, offsetY:number, cols:number, rows:number}|null}
 */
function detectGrid(imageData) {
  const { width, height, data } = imageData
  const step = 2 // 隔点采样提速
  const colDark = new Float32Array(width)
  const rowDark = new Float32Array(height)
  for (let y = 0; y < height; y += step) {
    let i = (y * width) * 4
    for (let x = 0; x < width; x += step) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      const dark = 255 - lum
      colDark[x] += dark
      rowDark[y] += dark
      i += step * 4
    }
  }
  const xInfo = analyzeProjection(colDark)
  const yInfo = analyzeProjection(rowDark)
  if (!xInfo || !yInfo) return null

  const cols = Math.round((width - xInfo.offset) / xInfo.gap)
  const rows = Math.round((height - yInfo.offset) / yInfo.gap)
  if (cols < 2 || rows < 2 || cols > 500 || rows > 500) return null

  return {
    cellW: xInfo.gap,
    cellH: yInfo.gap,
    offsetX: xInfo.offset,
    offsetY: yInfo.offset,
    cols,
    rows
  }
}

/**
 * 合并相近颜色（贪心聚类）
 */
function mergeSimilar(colors, threshold) {
  const kept = []
  const sorted = colors.slice().sort((a, b) => b.count - a.count)
  const t2 = threshold * threshold
  for (const c of sorted) {
    let found = null
    for (const k of kept) {
      const dr = c.r - k.r
      const dg = c.g - k.g
      const db = c.b - k.b
      if (dr * dr + dg * dg + db * db < t2) {
        found = k
        break
      }
    }
    if (found) {
      const total = found.count + c.count
      found.r = Math.round((found.r * found.count + c.r * c.count) / total)
      found.g = Math.round((found.g * found.count + c.g * c.count) / total)
      found.b = Math.round((found.b * found.count + c.b * c.count) / total)
      found.count = total
    } else {
      kept.push({ r: c.r, g: c.g, b: c.b, count: c.count })
    }
  }
  return kept
}

const MAX_COLORS = 80

/**
 * 按网格提取每格颜色并聚类编号
 * @param {ImageData} imageData
 * @param {{cellW:number, cellH:number, offsetX:number, offsetY:number, cols:number, rows:number}} grid
 * @returns {{palette:Array, cellMap:Int16Array, cols:number, rows:number}}
 */
function extractColors(imageData, grid) {
  const { width, height, data } = imageData
  const { cols, rows } = grid
  const total = cols * rows
  const cellR = new Float32Array(total)
  const cellG = new Float32Array(total)
  const cellB = new Float32Array(total)
  const buckets = new Map()
  const Q = 24 // 量化步长

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      // 取格子中心区域平均色，避开网格线和符号边缘
      const cx = grid.offsetX + (c + 0.5) * grid.cellW
      const cy = grid.offsetY + (r + 0.5) * grid.cellH
      const rx = Math.max(1, Math.floor(grid.cellW * 0.18))
      const ry = Math.max(1, Math.floor(grid.cellH * 0.18))
      const x0 = Math.max(0, Math.round(cx - rx))
      const x1 = Math.min(width - 1, Math.round(cx + rx))
      const y0 = Math.max(0, Math.round(cy - ry))
      const y1 = Math.min(height - 1, Math.round(cy + ry))
      let sr = 0
      let sg = 0
      let sb = 0
      let n = 0
      for (let y = y0; y <= y1; y++) {
        let i = (y * width + x0) * 4
        for (let x = x0; x <= x1; x++) {
          sr += data[i]
          sg += data[i + 1]
          sb += data[i + 2]
          i += 4
          n++
        }
      }
      const R = sr / n
      const G = sg / n
      const B = sb / n
      cellR[idx] = R
      cellG[idx] = G
      cellB[idx] = B
      const key = (((R / Q) | 0) << 8) | (((G / Q) | 0) << 4) | ((B / Q) | 0)
      let b = buckets.get(key)
      if (!b) {
        b = { r: 0, g: 0, b: 0, count: 0 }
        buckets.set(key, b)
      }
      b.r += R
      b.g += G
      b.b += B
      b.count++
    }
  }

  let palette = []
  buckets.forEach((b) => {
    palette.push({
      r: Math.round(b.r / b.count),
      g: Math.round(b.g / b.count),
      b: Math.round(b.b / b.count),
      count: b.count
    })
  })
  palette = mergeSimilar(palette, 42)
  palette.sort((a, b) => b.count - a.count)
  if (palette.length > MAX_COLORS) palette = palette.slice(0, MAX_COLORS)
  palette.forEach((p, i) => {
    p.num = i + 1
  })

  // 每个格子映射到最近的调色板颜色
  const cellMap = new Int16Array(total)
  for (let i = 0; i < total; i++) {
    let best = 0
    let bestD = Infinity
    for (let p = 0; p < palette.length; p++) {
      const dr = cellR[i] - palette[p].r
      const dg = cellG[i] - palette[p].g
      const db = cellB[i] - palette[p].b
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    cellMap[i] = best
  }

  return { palette, cellMap, cols, rows }
}

module.exports = {
  detectGrid,
  extractColors
}
