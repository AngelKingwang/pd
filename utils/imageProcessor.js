/**
 * 图像处理模块：网格自动检测（含四周数字定位）+ 颜色提取聚类
 * 针对十字绣/拼豆图纸：图上有规律网格线，四周边距常有每10格的数字标记
 */

/**
 * 分析一个方向上的暗度投影，找出网格线的间距与偏移
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

  return {
    gap: bestGap,
    offset,
    peaks,
    firstPeak: peaks[0],
    lastPeak: peaks[peaks.length - 1]
  }
}

/**
 * 在估计值附近微调偏移和间距，使网格线位置暗度最大（亚像素级对齐）
 */
function refineProjection(proj, info) {
  let bestScore = -1
  let bestOffset = info.offset
  let bestGap = info.gap
  for (let dg = -1; dg <= 1; dg += 0.5) {
    const gap = info.gap + dg
    if (gap < 3) continue
    for (let doff = -3; doff <= 3; doff++) {
      const offset = info.offset + doff
      let sum = 0
      let count = 0
      for (let x = offset; x < proj.length; x += gap) {
        const xi = Math.round(x)
        if (xi >= 0 && xi < proj.length) {
          sum += proj[xi]
          count++
        }
      }
      const score = count ? sum / count : 0
      if (score > bestScore) {
        bestScore = score
        bestOffset = offset
        bestGap = gap
      }
    }
  }
  info.offset = bestOffset
  info.gap = bestGap
}

/**
 * 在投影中找出连续暗区的加权中心（用于定位边距中的数字）
 */
function findBlobCenters(proj, gap) {
  const n = proj.length
  let max = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += proj[i]
    if (proj[i] > max) max = proj[i]
  }
  if (max <= 0) return []
  const mean = sum / n
  const th = mean + (max - mean) * 0.45

  // 连续超阈值区段
  const regions = []
  let start = -1
  for (let i = 0; i < n; i++) {
    if (proj[i] > th) {
      if (start < 0) start = i
    } else if (start >= 0) {
      regions.push([start, i - 1])
      start = -1
    }
  }
  if (start >= 0) regions.push([start, n - 1])

  // 合并距离过近的区段（同一个多位数字的多个笔画/数位）
  const merged = []
  for (const r of regions) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] < gap * 1.2) {
      last[1] = r[1]
    } else {
      merged.push([r[0], r[1]])
    }
  }

  // 加权中心，过滤过宽区域（不太可能是数字）
  const centers = []
  for (const [a, b] of merged) {
    if (b - a > gap * 4) continue
    let ws = 0
    let wsum = 0
    for (let i = a; i <= b; i++) {
      ws += proj[i] * i
      wsum += proj[i]
    }
    if (wsum > 0) centers.push(ws / wsum)
  }
  return centers
}

/**
 * 根据一组标记位置（数字中心或粗线）投票决定 10 格实线的相位
 * @returns {number|null} 需要应用到索引上的位移 s（0-9），null 表示无法确定
 */
function votePhase(centers, offset, gap) {
  if (!centers || centers.length < 2) return null
  // 校验存在 ≈10格 整数倍的间距（数字/粗线应每10格出现一次）
  let ok = false
  for (let i = 1; i < centers.length; i++) {
    const d = centers[i] - centers[i - 1]
    const k = Math.round(d / (10 * gap))
    if (k >= 1 && Math.abs(d - k * 10 * gap) < gap * 1.5) {
      ok = true
      break
    }
  }
  if (!ok) return null

  const votes = new Map()
  for (const c of centers) {
    const idx = Math.round((c - offset) / gap)
    const m = ((idx % 10) + 10) % 10
    const s = (10 - m) % 10
    votes.set(s, (votes.get(s) || 0) + 1)
  }
  let bestS = null
  let bestN = 0
  votes.forEach((n, s) => {
    if (n > bestN) {
      bestN = n
      bestS = s
    }
  })
  return bestS
}

/**
 * 备用方案：用网格线中的粗线（每10格一条）确定相位
 */
function boldLinePhase(proj, peaks, offset, gap) {
  if (!peaks || peaks.length < 3) return null
  let max = 0
  let sum = 0
  for (const p of peaks) {
    sum += proj[p]
    if (proj[p] > max) max = proj[p]
  }
  const mean = sum / peaks.length
  const th = mean + (max - mean) * 0.45
  const bold = peaks.filter((p) => proj[p] >= th)
  return votePhase(bold, offset, gap)
}

/**
 * 检测四周边距中的数字位置，确定 10 格实线相位
 * @param axis 'x' 检测上下边距的数字（决定竖线相位），'y' 检测左右边距
 */
function detectNumberPhase(imageData, info, crossInfo, axis) {
  const { width, height, data } = imageData
  const crossLen = axis === 'x' ? height : width
  const len = axis === 'x' ? width : height

  // 边距区域：网格线之外的部分（数字一般印在这里）
  const ranges = []
  if (crossInfo.firstPeak > 4) ranges.push([0, crossInfo.firstPeak])
  const tailStart = crossInfo.lastPeak + 1
  if (crossLen - tailStart > 4) ranges.push([tailStart, crossLen])
  if (!ranges.length) return null

  const proj = new Float32Array(len)
  const step = 2
  for (const [r0, r1] of ranges) {
    for (let a = r0; a < r1; a += step) {
      if (axis === 'x') {
        let i = a * width * 4
        for (let x = 0; x < width; x += step) {
          proj[x] += 255 - (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
          i += step * 4
        }
      } else {
        for (let y = 0; y < height; y += step) {
          const i = (y * width + a) * 4
          proj[y] += 255 - (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
        }
      }
    }
  }

  const centers = findBlobCenters(proj, info.gap)
  return votePhase(centers, info.offset, info.gap)
}

/**
 * 自动检测图纸网格（含四周数字定位 10 格实线相位）
 * @returns {{cellW:number, cellH:number, offsetX:number, offsetY:number, cols:number, rows:number}|null}
 */
function detectGrid(imageData) {
  const { width, height, data } = imageData
  const step = 2 // 隔点采样提速
  const colDark = new Float32Array(width)
  const rowDark = new Float32Array(height)
  for (let y = 0; y < height; y += step) {
    let i = y * width * 4
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

  // 精修对齐
  refineProjection(colDark, xInfo)
  refineProjection(rowDark, yInfo)

  // 根据四周数字确定 10 格实线相位；失败则用粗线兜底
  let sx = detectNumberPhase(imageData, xInfo, yInfo, 'x')
  if (sx === null) sx = boldLinePhase(colDark, xInfo.peaks, xInfo.offset, xInfo.gap)
  let sy = detectNumberPhase(imageData, yInfo, xInfo, 'y')
  if (sy === null) sy = boldLinePhase(rowDark, yInfo.peaks, yInfo.offset, yInfo.gap)
  if (sx) xInfo.offset -= sx * xInfo.gap
  if (sy) yInfo.offset -= sy * yInfo.gap

  const cols = Math.max(1, Math.round((width - xInfo.offset) / xInfo.gap))
  const rows = Math.max(1, Math.round((height - yInfo.offset) / yInfo.gap))
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
 * 网格区域在图片中的包围盒（用于自动裁掉四周数字和色卡）
 */
function gridBBox(grid, width, height) {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
  const x0 = clamp(Math.round(grid.offsetX), 0, width)
  const y0 = clamp(Math.round(grid.offsetY), 0, height)
  const x1 = clamp(Math.round(grid.offsetX + grid.cols * grid.cellW), 0, width)
  const y1 = clamp(Math.round(grid.offsetY + grid.rows * grid.cellH), 0, height)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
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
  gridBBox,
  extractColors
}
