const { detectGrid, extractColors } = require('../../utils/imageProcessor')

const MAX_DIM = 1600 // 导入图片压缩上限，避免内存溢出
const MIN_SCALE = 0.2
const MAX_SCALE = 12

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v
}

function touchDist(touches) {
  const dx = touches[0].x - touches[1].x
  const dy = touches[0].y - touches[1].y
  return Math.sqrt(dx * dx + dy * dy)
}

function touchMid(touches) {
  return {
    x: (touches[0].x + touches[1].x) / 2,
    y: (touches[0].y + touches[1].y) / 2
  }
}

Page({
  data: {
    hasImage: false,
    canvasHeight: 400,
    palette: [],
    selectedColor: null,
    cropMode: false,
    gridCols: 0,
    gridRows: 0
  },

  onLoad() {
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ canvasHeight: Math.round(win.windowHeight * 0.52) })
    this.scale = 1
    this.offsetX = 0
    this.offsetY = 0
  },

  onReady() {
    wx.createSelectorQuery()
      .select('#mainCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0]) return
        const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const dpr = win.pixelRatio || 2
        const node = res[0].node
        node.width = Math.round(res[0].width * dpr)
        node.height = Math.round(res[0].height * dpr)
        this.canvas = node
        this.ctx = node.getContext('2d')
        this.dpr = dpr
        this.viewW = res[0].width
        this.viewH = res[0].height
      })
  },

  // ---------- 导入图片 ----------

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const path = res.tempFiles[0].tempFilePath
        this.loadImage(path)
      }
    })
  },

  loadImage(path) {
    if (!this.canvas) {
      wx.showToast({ title: '画布未就绪', icon: 'none' })
      return
    }
    wx.showLoading({ title: '处理中...' })
    const img = this.canvas.createImage()
    img.onload = () => {
      // 按原比例压缩到限制尺寸内，不拉伸
      const s = Math.min(1, MAX_DIM / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * s))
      const h = Math.max(1, Math.round(img.height * s))
      const off = wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
      const octx = off.getContext('2d')
      octx.drawImage(img, 0, 0, w, h)
      this.img = off
      this.imgW = w
      this.imgH = h
      this.imageData = octx.getImageData(0, 0, w, h)
      this.setData({ hasImage: true, cropMode: false, selectedColor: null })
      this.autoGrid()
      this.fitView()
      wx.hideLoading()
    }
    img.onerror = () => {
      wx.hideLoading()
      wx.showToast({ title: '图片加载失败', icon: 'none' })
    }
    img.src = path
  },

  // ---------- 网格与取色 ----------

  autoGrid() {
    if (!this.imageData) return
    const grid = detectGrid(this.imageData) || this.defaultGrid()
    this.grid = grid
    this.setData({ gridCols: grid.cols, gridRows: grid.rows })
    this.extract()
  },

  defaultGrid() {
    const cols = 50
    const rows = Math.max(1, Math.round((cols * this.imgH) / this.imgW))
    return {
      offsetX: 0,
      offsetY: 0,
      cellW: this.imgW / cols,
      cellH: this.imgH / rows,
      cols,
      rows
    }
  },

  applyGridFromInput() {
    const cols = parseInt(this.data.gridCols, 10)
    const rows = parseInt(this.data.gridRows, 10)
    if (!cols || !rows || cols < 1 || rows < 1 || cols > 500 || rows > 500) {
      wx.showToast({ title: '格数需在 1-500 之间', icon: 'none' })
      return
    }
    this.grid = {
      offsetX: 0,
      offsetY: 0,
      cellW: this.imgW / cols,
      cellH: this.imgH / rows,
      cols,
      rows
    }
    this.extract()
  },

  onColsBlur(e) {
    this.setData({ gridCols: e.detail.value })
    this.applyGridFromInput()
  },

  onRowsBlur(e) {
    this.setData({ gridRows: e.detail.value })
    this.applyGridFromInput()
  },

  reExtract() {
    if (!this.imageData) return
    this.extract()
    wx.showToast({ title: '已重新取色', icon: 'none' })
  },

  extract() {
    const res = extractColors(this.imageData, this.grid)
    this.cellMap = res.cellMap
    const palette = res.palette.map((p) => ({
      num: p.num,
      count: p.count,
      css: `rgb(${p.r},${p.g},${p.b})`
    }))
    this.setData({ palette, selectedColor: null })
    this.render()
  },

  // ---------- 视图（缩放 / 平移，保持原图比例） ----------

  fitView() {
    if (!this.img) return
    this.scale = Math.min(this.viewW / this.imgW, this.viewH / this.imgH) * 0.96
    this.offsetX = (this.viewW - this.imgW * this.scale) / 2
    this.offsetY = (this.viewH - this.imgH * this.scale) / 2
    this.render()
  },

  zoomIn() {
    this.zoomAt(this.viewW / 2, this.viewH / 2, this.scale * 1.3)
  },

  zoomOut() {
    this.zoomAt(this.viewW / 2, this.viewH / 2, this.scale / 1.3)
  },

  zoomAt(px, py, newScale) {
    newScale = clamp(newScale, MIN_SCALE, MAX_SCALE)
    const ix = (px - this.offsetX) / this.scale
    const iy = (py - this.offsetY) / this.scale
    this.scale = newScale
    this.offsetX = px - ix * newScale
    this.offsetY = py - iy * newScale
    this.render()
  },

  // ---------- 触摸交互 ----------

  onTouchStart(e) {
    const touches = e.touches
    this.cropDrag = null
    this.touchMode = null
    if (touches.length === 2 && !this.data.cropMode) {
      this.touchMode = 'pinch'
      this.pinch = {
        dist: touchDist(touches),
        scale: this.scale,
        mid: touchMid(touches),
        offsetX: this.offsetX,
        offsetY: this.offsetY
      }
    } else if (touches.length === 1) {
      const t = touches[0]
      if (this.data.cropMode) {
        this.cropDrag = this.hitCrop(t)
      } else {
        this.touchMode = 'pan'
        this.panStart = { x: t.x, y: t.y, offsetX: this.offsetX, offsetY: this.offsetY }
      }
    }
  },

  onTouchMove(e) {
    const touches = e.touches
    if (this.touchMode === 'pinch' && touches.length === 2) {
      const p = this.pinch
      const newScale = clamp((p.scale * touchDist(touches)) / p.dist, MIN_SCALE, MAX_SCALE)
      const m = touchMid(touches)
      const ix = (p.mid.x - p.offsetX) / p.scale
      const iy = (p.mid.y - p.offsetY) / p.scale
      this.scale = newScale
      this.offsetX = m.x - ix * newScale
      this.offsetY = m.y - iy * newScale
      this.render()
    } else if (this.touchMode === 'pan' && touches.length === 1) {
      const t = touches[0]
      this.offsetX = this.panStart.offsetX + (t.x - this.panStart.x)
      this.offsetY = this.panStart.offsetY + (t.y - this.panStart.y)
      this.render()
    } else if (this.cropDrag && touches.length === 1) {
      this.moveCrop(touches[0])
    }
  },

  onTouchEnd() {
    this.touchMode = null
    this.cropDrag = null
  },

  // ---------- 裁剪（裁掉色卡、边缘数字） ----------

  toggleCrop() {
    if (!this.data.cropMode) {
      this.cropRect = { x: 0, y: 0, w: this.imgW, h: this.imgH }
      this.setData({ cropMode: true })
      this.fitView()
    } else {
      this.applyCrop()
    }
  },

  hitCrop(t) {
    const ix = (t.x - this.offsetX) / this.scale
    const iy = (t.y - this.offsetY) / this.scale
    const r = this.cropRect
    const tol = 24 / this.scale
    if (Math.abs(ix - r.x) < tol && Math.abs(iy - r.y) < tol) return { mode: 'tl' }
    if (Math.abs(ix - (r.x + r.w)) < tol && Math.abs(iy - (r.y + r.h)) < tol) return { mode: 'br' }
    if (ix > r.x && ix < r.x + r.w && iy > r.y && iy < r.y + r.h) {
      return { mode: 'move', dx: ix - r.x, dy: iy - r.y }
    }
    return { mode: 'new', startX: ix, startY: iy }
  },

  moveCrop(t) {
    const ix = clamp((t.x - this.offsetX) / this.scale, 0, this.imgW)
    const iy = clamp((t.y - this.offsetY) / this.scale, 0, this.imgH)
    const r = this.cropRect
    const d = this.cropDrag
    if (d.mode === 'move') {
      r.x = clamp(ix - d.dx, 0, this.imgW - r.w)
      r.y = clamp(iy - d.dy, 0, this.imgH - r.h)
    } else if (d.mode === 'tl') {
      const nx = Math.min(ix, r.x + r.w - 10)
      const ny = Math.min(iy, r.y + r.h - 10)
      r.w += r.x - nx
      r.h += r.y - ny
      r.x = nx
      r.y = ny
    } else if (d.mode === 'br') {
      r.w = Math.max(10, ix - r.x)
      r.h = Math.max(10, iy - r.y)
    } else if (d.mode === 'new') {
      r.x = Math.min(d.startX, ix)
      r.y = Math.min(d.startY, iy)
      r.w = Math.abs(ix - d.startX)
      r.h = Math.abs(iy - d.startY)
    }
    this.render()
  },

  applyCrop() {
    const r = this.cropRect
    const x = clamp(Math.round(r.x), 0, this.imgW - 1)
    const y = clamp(Math.round(r.y), 0, this.imgH - 1)
    const w = clamp(Math.round(r.w), 1, this.imgW - x)
    const h = clamp(Math.round(r.h), 1, this.imgH - y)
    if (w < 10 || h < 10) {
      wx.showToast({ title: '裁剪区域太小', icon: 'none' })
      return
    }
    const off = wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
    const octx = off.getContext('2d')
    octx.drawImage(this.img, x, y, w, h, 0, 0, w, h)
    this.img = off
    this.imgW = w
    this.imgH = h
    this.imageData = octx.getImageData(0, 0, w, h)
    this.setData({ cropMode: false })
    this.autoGrid()
    this.fitView()
  },

  // ---------- 颜色块 ----------

  onColorTap(e) {
    const idx = e.currentTarget.dataset.idx
    const sel = this.data.selectedColor === idx ? null : idx
    this.setData({ selectedColor: sel })
    this.render()
  },

  // ---------- 渲染 ----------

  render() {
    if (!this.ctx || !this.img) return
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.viewW, this.viewH)

    ctx.save()
    ctx.translate(this.offsetX, this.offsetY)
    ctx.scale(this.scale, this.scale)
    ctx.imageSmoothingEnabled = this.scale < 1
    ctx.drawImage(this.img, 0, 0)

    // 高亮选中颜色，其他颜色压暗
    const sel = this.data.selectedColor
    if (sel !== null && this.cellMap) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.fillRect(0, 0, this.imgW, this.imgH)
      const g = this.grid
      for (let r = 0; r < g.rows; r++) {
        let c = 0
        while (c < g.cols) {
          if (this.cellMap[r * g.cols + c] === sel) {
            let c2 = c
            while (c2 + 1 < g.cols && this.cellMap[r * g.cols + c2 + 1] === sel) c2++
            const sx = g.offsetX + c * g.cellW
            const sw = (c2 - c + 1) * g.cellW
            const sy = g.offsetY + r * g.cellH
            ctx.drawImage(this.img, sx, sy, sw, g.cellH, sx, sy, sw, g.cellH)
            c = c2 + 1
          } else {
            c++
          }
        }
      }
    }

    this.drawGridLines(ctx)
    ctx.restore()

    if (this.data.cropMode && this.cropRect) {
      this.drawCropOverlay(ctx)
    }
  },

  // 横竖每 10 格一条实线，中间第 5 格一条虚线
  drawGridLines(ctx) {
    const g = this.grid
    if (!g) return
    const lwSolid = Math.max(1.4 / this.scale, 0.3)
    const lwDash = Math.max(0.8 / this.scale, 0.2)
    const dashSeg = [5 / this.scale, 4 / this.scale]
    const x0 = g.offsetX
    const y0 = g.offsetY
    const x1 = g.offsetX + g.cols * g.cellW
    const y1 = g.offsetY + g.rows * g.cellH

    for (let i = 0; i <= g.cols; i++) {
      if (i % 10 === 0) {
        ctx.strokeStyle = 'rgba(20, 20, 20, 0.9)'
        ctx.lineWidth = lwSolid
        ctx.setLineDash([])
      } else if (i % 5 === 0) {
        ctx.strokeStyle = 'rgba(20, 20, 20, 0.5)'
        ctx.lineWidth = lwDash
        ctx.setLineDash(dashSeg)
      } else {
        continue
      }
      const x = x0 + i * g.cellW
      ctx.beginPath()
      ctx.moveTo(x, y0)
      ctx.lineTo(x, y1)
      ctx.stroke()
    }
    for (let j = 0; j <= g.rows; j++) {
      if (j % 10 === 0) {
        ctx.strokeStyle = 'rgba(20, 20, 20, 0.9)'
        ctx.lineWidth = lwSolid
        ctx.setLineDash([])
      } else if (j % 5 === 0) {
        ctx.strokeStyle = 'rgba(20, 20, 20, 0.5)'
        ctx.lineWidth = lwDash
        ctx.setLineDash(dashSeg)
      } else {
        continue
      }
      const y = y0 + j * g.cellH
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.lineTo(x1, y)
      ctx.stroke()
    }
    ctx.setLineDash([])
  },

  drawCropOverlay(ctx) {
    const r = this.cropRect
    ctx.save()
    ctx.translate(this.offsetX, this.offsetY)
    ctx.scale(this.scale, this.scale)
    // 外部遮罩
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.fillRect(0, 0, this.imgW, r.y)
    ctx.fillRect(0, r.y + r.h, this.imgW, this.imgH - r.y - r.h)
    ctx.fillRect(0, r.y, r.x, r.h)
    ctx.fillRect(r.x + r.w, r.y, this.imgW - r.x - r.w, r.h)
    // 边框
    ctx.strokeStyle = '#ff3b30'
    ctx.lineWidth = 2 / this.scale
    ctx.setLineDash([6 / this.scale, 4 / this.scale])
    ctx.strokeRect(r.x, r.y, r.w, r.h)
    ctx.setLineDash([])
    // 左上角 / 右下角手柄
    const hs = 12 / this.scale
    ctx.fillStyle = '#ff3b30'
    ctx.fillRect(r.x - hs / 2, r.y - hs / 2, hs, hs)
    ctx.fillRect(r.x + r.w - hs / 2, r.y + r.h - hs / 2, hs, hs)
    ctx.restore()
  }
})
