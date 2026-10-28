// 宿主侧二维码编码器：零依赖、纯 ESM、Node >= 20。
//
// 移植自 qrcode-generator（MIT，Kazuhiko Arase），裁到本项目实际用到的范围：
// 字节模式 + 纠错等级 M + 版本 1–10。版权头与裁剪说明见 THIRD_PARTY_NOTICES.md。
//
// 为什么在宿主侧算：lib/client.js 是单文件 window.__ModuleLoader__ 包，factory 只能
// require("react")，拿不到相对路径模块；所以二维码在宿主算好，随 GET /platforms 下发。

// 纠错等级 M 的格式位（L=1, M=0, Q=3, H=2），见 ISO/IEC 18004 表 C.1
const EC_LEVEL_BITS_M = 0;
const MAX_VERSION = 10;
const DEFAULT_MARGIN = 4;
const DEFAULT_SIZE = 200;

// 版本 -> RS 分块：[块数, 块总码字, 块数据码字]，取自 RS_BLOCK_TABLE 的 M 档
const RS_BLOCKS = {
  1: [[1, 26, 16]],
  2: [[1, 44, 28]],
  3: [[1, 70, 44]],
  4: [[2, 50, 32]],
  5: [[2, 67, 43]],
  6: [[4, 43, 27]],
  7: [[4, 49, 31]],
  8: [[2, 60, 38], [2, 61, 39]],
  9: [[3, 58, 36], [2, 59, 37]],
  10: [[4, 69, 43], [1, 70, 44]]
};

// 版本 -> 校正图形中心坐标（PATTERN_POSITION_TABLE）
const ALIGN_POSITIONS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
};

// BCH 生成多项式（G15 用于格式信息，G18 用于版本信息）
const G15 = 0x537;
const G15_MASK = 0x5412;
const G18 = 0x1f25;

const MASK_FUNCTIONS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
];

// ---------------- GF(256) 与 Reed-Solomon ----------------

const GF_EXP = new Array(512).fill(0);
const GF_LOG = new Array(256).fill(0);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

let generatorCache = null;

function rsGenerator(degree) {
  if (generatorCache && generatorCache.degree === degree) return generatorCache.poly;
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    // poly *= (x + alpha^i)
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  generatorCache = { degree, poly };
  return poly;
}

function rsRemainder(data, ecCount) {
  const generator = rsGenerator(ecCount);
  const rest = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ rest[0];
    rest.shift();
    rest.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i += 1) rest[i] ^= gfMul(generator[i + 1], factor);
    }
  }
  return rest;
}

// ---------------- 码字组装 ----------------

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  get length() {
    return this.bits.length;
  }

  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      out.push(byte);
    }
    return out;
  }
}

function dataCodewords(version) {
  return RS_BLOCKS[version].reduce((sum, block) => sum + block[0] * block[2], 0);
}

function totalCodewords(version) {
  return RS_BLOCKS[version].reduce((sum, block) => sum + block[0] * block[1], 0);
}

// 字节模式的字符计数指示符：版本 1–9 是 8 位，10–26 是 16 位
function countBits(version) {
  return version <= 9 ? 8 : 16;
}

function capacityBytes(version) {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

function buildCodewords(bytes, version) {
  const capacity = dataCodewords(version) * 8;
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4);
  buffer.put(bytes.length, countBits(version));
  for (const byte of bytes) buffer.put(byte, 8);
  if (buffer.length > capacity) throw new Error('内容超出容量');
  buffer.put(0, Math.min(4, capacity - buffer.length));
  while (buffer.length % 8 !== 0) buffer.put(0, 1);
  const pads = [0xec, 0x11];
  for (let i = 0; buffer.length < capacity; i += 1) buffer.put(pads[i % 2], 8);
  return buffer.toBytes();
}

// 数据码字按块切分、各自算 EC，再按标准交织
function interleave(bytes, version) {
  const codewords = buildCodewords(bytes, version);
  const blocks = [];
  let offset = 0;
  for (const [count, total, dataLen] of RS_BLOCKS[version]) {
    for (let i = 0; i < count; i += 1) {
      const chunk = codewords.slice(offset, offset + dataLen);
      offset += dataLen;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, total - dataLen) });
    }
  }
  if (offset !== codewords.length) throw new Error('RS 分块与数据码字数对不上');
  const out = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  const maxEc = Math.max(...blocks.map((block) => block.ec.length));
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of blocks) if (i < block.ec.length) out.push(block.ec[i]);
  }
  return out;
}

// ---------------- 矩阵绘制 ----------------

function createMatrix(size) {
  const modules = new Array(size);
  for (let row = 0; row < size; row += 1) modules[row] = new Array(size).fill(null);
  return modules;
}

function placeFinder(modules, row, col) {
  const size = modules.length;
  for (let r = -1; r <= 7; r += 1) {
    if (row + r <= -1 || size <= row + r) continue;
    for (let c = -1; c <= 7; c += 1) {
      if (col + c <= -1 || size <= col + c) continue;
      // 7×7 外框黑 → 5×5 白环 → 3×3 黑心；r/c = -1 与 7 是分隔带，写成浅色
      const dark =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      modules[row + r][col + c] = dark;
    }
  }
}

function placeAlignment(modules, version) {
  const positions = ALIGN_POSITIONS[version] ?? [];
  for (const row of positions) {
    for (const col of positions) {
      // 压到定位图形上的坐标按标准不画校正图形
      if (modules[row][col] !== null) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          modules[row + r][col + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
        }
      }
    }
  }
}

function placeTiming(modules) {
  const size = modules.length;
  for (let i = 8; i < size - 8; i += 1) {
    // 第 6 行/第 6 列：从索引 8 起深浅交替，偶数索引为深色
    if (modules[6][i] === null) modules[6][i] = i % 2 === 0;
    if (modules[i][6] === null) modules[i][6] = i % 2 === 0;
  }
}

function bchDigit(value) {
  let digit = 0;
  let data = value;
  while (data !== 0) {
    digit += 1;
    data >>>= 1;
  }
  return digit;
}

function bchRemainder(value, generator) {
  let rest = value;
  while (bchDigit(rest) - bchDigit(generator) >= 0) rest ^= generator << (bchDigit(rest) - bchDigit(generator));
  return rest;
}

function typeInfoBits(maskPattern) {
  const data = (EC_LEVEL_BITS_M << 3) | maskPattern;
  return ((data << 10) | bchRemainder(data << 10, G15)) ^ G15_MASK;
}

function typeNumberBits(version) {
  return (version << 12) | bchRemainder(version << 12, G18);
}

function placeTypeInfo(modules, maskPattern) {
  const size = modules.length;
  const bits = typeInfoBits(maskPattern);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) modules[i][8] = dark;
    else if (i < 8) modules[i + 1][8] = dark;
    else modules[size - 15 + i][8] = dark;

    if (i < 8) modules[8][size - i - 1] = dark;
    else if (i < 9) modules[8][15 - i - 1 + 1] = dark;
    else modules[8][15 - i - 1] = dark;
  }
  // 固定深色模块：规格要求这个位置恒为黑，解码器拿它校准
  modules[size - 8][8] = true;
}

function placeTypeNumber(modules, version) {
  const size = modules.length;
  const bits = typeNumberBits(version);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    modules[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = dark;
    modules[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = dark;
  }
}

function mapData(modules, codewords, maskPattern) {
  const size = modules.length;
  const mask = MASK_FUNCTIONS[maskPattern];
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    // 第 6 列是时序图形，不参与数据排布
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        if (modules[row][col - c] !== null) continue;
        const bit = byteIndex < codewords.length ? ((codewords[byteIndex] >>> bitIndex) & 1) === 1 : false;
        modules[row][col - c] = mask(row, col - c) ? !bit : bit;
        bitIndex -= 1;
        if (bitIndex === -1) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += inc;
      if (row < 0 || size <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

// 四种惩罚规则只影响 mask 选择（不影响可解码性），按规格实现以贴近扫码效果
function penalty(modules) {
  const size = modules.length;
  let score = 0;

  for (let row = 0; row < size; row += 1) {
    let run = 1;
    for (let col = 1; col < size; col += 1) {
      if (modules[row][col] === modules[row][col - 1]) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }

  for (let col = 0; col < size; col += 1) {
    let run = 1;
    for (let row = 1; row < size; row += 1) {
      if (modules[row][col] === modules[row - 1][col]) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = modules[row][col];
      if (value === modules[row][col + 1] && value === modules[row + 1][col] && value === modules[row + 1][col + 1]) {
        score += 3;
      }
    }
  }

  const finderLike = [true, false, true, true, true, false, true];
  const checkRun = (at) => {
    for (let i = 0; i < 7; i += 1) if (at(i) !== finderLike[i]) return false;
    return true;
  };
  const clearRun = (at, count) => {
    for (let i = 1; i <= count; i += 1) if (at(-i)) return false;
    return true;
  };
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col + 7 <= size; col += 1) {
      if (!checkRun((i) => modules[row][col + i])) continue;
      const before = clearRun((i) => (col + i < 0 ? false : modules[row][col + i]), 4);
      const after = clearRun((i) => (col + 6 + i >= size ? false : modules[row][col + 6 + i]), 4);
      if (before || after) score += 40;
    }
  }
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row + 7 <= size; row += 1) {
      if (!checkRun((i) => modules[row + i][col])) continue;
      const before = clearRun((i) => (row + i < 0 ? false : modules[row + i][col]), 4);
      const after = clearRun((i) => (row + 6 + i >= size ? false : modules[row + 6 + i][col]), 4);
      if (before || after) score += 40;
    }
  }

  let dark = 0;
  for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) if (modules[row][col]) dark += 1;
  score += Math.floor(Math.abs((100 * dark) / (size * size) - 50) / 5) * 10;
  return score;
}

function buildModules(version, codewords, maskPattern) {
  const size = version * 4 + 17;
  const modules = createMatrix(size);
  placeFinder(modules, 0, 0);
  placeFinder(modules, size - 7, 0);
  placeFinder(modules, 0, size - 7);
  placeAlignment(modules, version);
  placeTiming(modules);
  placeTypeInfo(modules, maskPattern);
  if (version >= 7) placeTypeNumber(modules, version);
  mapData(modules, codewords, maskPattern);
  return modules;
}

// ---------------- 对外接口 ----------------

function toBytes(text) {
  return Array.from(new TextEncoder().encode(text));
}

export function encodeQr(text, options = {}) {
  const input = typeof text === 'string' ? text : String(text ?? '');
  const bytes = toBytes(input);
  const forced = Number(options && options.minVersion);
  let version = 0;
  for (let candidate = Number.isInteger(forced) && forced > 0 ? forced : 1; candidate <= MAX_VERSION; candidate += 1) {
    if (bytes.length <= capacityBytes(candidate)) {
      version = candidate;
      break;
    }
  }
  if (version === 0) {
    // 宁可抛错也不截断：截断后的二维码能扫出来，但扫出来的是错的内容
    throw new Error('内容超出容量：纠错 M 下版本 1–10 最多 ' + capacityBytes(MAX_VERSION) + ' 字节，实际 ' + bytes.length + ' 字节');
  }
  const codewords = interleave(bytes, version);
  if (codewords.length !== totalCodewords(version)) throw new Error('码字总数与容量表对不上');

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = buildModules(version, codewords, mask);
    const score = penalty(modules);
    if (best === null || score < best.score) best = { mask, modules, score };
  }

  return {
    version,
    size: version * 4 + 17,
    mask: best.mask,
    ecLevel: 'M',
    modules: best.modules.map((row) => row.map((value) => value === true))
  };
}

function isColor(value, fallback) {
  return typeof value === 'string' && /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(value) ? value : fallback;
}

function normalizeGrid(input) {
  const grid = input && !Array.isArray(input) && Array.isArray(input.modules) ? input.modules : input;
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0]) || grid[0].length !== grid.length) {
    throw new Error('qrToSvg 需要方形的模块矩阵');
  }
  return grid;
}

export function qrToSvg(modules, options = {}) {
  const grid = normalizeGrid(modules);
  const count = grid.length;
  const margin = Number.isInteger(options.margin) ? Math.max(0, options.margin) : DEFAULT_MARGIN;
  const size = Number.isFinite(options.size) && options.size > 0 ? Math.round(options.size) : DEFAULT_SIZE;
  // 颜色只接受 #hex 或简单色名：这个字符串最后会进 HTML
  const dark = isColor(options.dark, '#000000');
  const light = isColor(options.light, '#ffffff');
  const span = count + margin * 2;
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + span + ' ' + span +
      '" shape-rendering="crispEdges" role="img" aria-label="二维码">'
  ];
  // 底色用 path 而不是 rect：<rect> 的条数恒等于深色模块数，渲染侧和测试都按它对账
  parts.push('<path d="M0 0h' + span + 'v' + span + 'H0z" fill="' + light + '"/>');
  parts.push('<g fill="' + dark + '">');
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (grid[row][col] === true) {
        parts.push('<rect x="' + (col + margin) + '" y="' + (row + margin) + '" width="1" height="1"/>');
      }
    }
  }
  parts.push('</g></svg>');
  return parts.join('');
}

export const QR_MAX_VERSION = MAX_VERSION;
