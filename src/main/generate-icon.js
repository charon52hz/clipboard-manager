/**
 * 生成一个极简的 16x16 剪贴板图标 PNG
 * 纯 JavaScript 实现，无需额外依赖
 */

const zlib = require('zlib')

function crc32(buf) {
  let crc = 0xFFFFFFFF
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function createPNGChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)

  const crcInput = Buffer.concat([typeBytes, data])
  const crcVal = Buffer.alloc(4)
  crcVal.writeUInt32BE(crc32(crcInput), 0)

  return Buffer.concat([len, typeBytes, data, crcVal])
}

function createClipboardIconPNG() {
  const W = 16, H = 16

  // 创建 RGBA 像素数据
  const pixels = Buffer.alloc(W * H * 4, 0)

  function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= W || y < 0 || y >= H) return
    const idx = (y * W + x) * 4
    pixels[idx] = r
    pixels[idx + 1] = g
    pixels[idx + 2] = b
    pixels[idx + 3] = a
  }

  function drawHLine(x1, x2, y, r, g, b, a) {
    for (let x = x1; x <= x2; x++) setPixel(x, y, r, g, b, a)
  }

  function drawVLine(x, y1, y2, r, g, b, a) {
    for (let y = y1; y <= y2; y++) setPixel(x, y, r, g, b, a)
  }

  const R = 160, G = 160, B = 160 // 灰色

  // 剪贴板主体 - 外框 (3,3) 到 (12,14)
  drawHLine(4, 11, 3, R, G, B)   // 顶
  drawHLine(4, 11, 14, R, G, B)  // 底
  drawVLine(3, 4, 14, R, G, B)   // 左
  drawVLine(12, 4, 14, R, G, B)  // 右

  // 顶部夹子 (5,1) 到 (10,4)
  drawHLine(6, 9, 1, R, G, B)    // 顶
  drawHLine(6, 9, 4, R, G, B)    // 底
  drawVLine(5, 2, 4, R, G, B)    // 左
  drawVLine(10, 2, 4, R, G, B)   // 右

  // 横线装饰 (模拟文字行)
  drawHLine(5, 10, 7, R, G, B)
  drawHLine(5, 10, 9, R, G, B)
  drawHLine(5, 8, 11, R, G, B)

  // 构造 PNG 文件
  // PNG Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR chunk
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)       // width
  ihdr.writeUInt32BE(H, 4)       // height
  ihdr[8] = 8                    // bit depth
  ihdr[9] = 6                    // color type: RGBA
  ihdr[10] = 0                   // compression
  ihdr[11] = 0                   // filter
  ihdr[12] = 0                   // interlace

  // IDAT chunk - 原始图像数据（带 filter byte）
  const rawData = Buffer.alloc(H * (1 + W * 4))
  for (let y = 0; y < H; y++) {
    rawData[y * (1 + W * 4)] = 0 // filter: none
    pixels.copy(rawData, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4)
  }
  const compressed = zlib.deflateSync(rawData)

  // IEND chunk
  const iend = Buffer.alloc(0)

  return Buffer.concat([
    signature,
    createPNGChunk('IHDR', ihdr),
    createPNGChunk('IDAT', compressed),
    createPNGChunk('IEND', iend)
  ])
}

module.exports = { createClipboardIconPNG }
