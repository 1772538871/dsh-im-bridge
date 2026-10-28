import assert from 'node:assert/strict';
import test from 'node:test';

import { API_PREFIX, WIZARD_QR_TARGETS, buildWizardQr, createApiHandler, wizardQrPayload } from '../src/plugin/routes.mjs';
import { QR_MAX_VERSION, encodeQr, qrToSvg } from '../lib/qr.js';

const OFFICIAL_URL = 'https://q.qq.com/qqbot/#/developer';
const NAPCAT_URL = 'http://127.0.0.1:6099';

function darkCount(qr) {
  let count = 0;
  for (const row of qr.modules) for (const cell of row) if (cell === true) count += 1;
  return count;
}

function fakeRes() {
  const parts = [];
  return {
    statusCode: 0,
    writeHead(code) {
      this.statusCode = code;
    },
    end(text) {
      parts.push(String(text));
    },
    body() {
      return parts.join('');
    }
  };
}

// /platforms 只读平台字段表，不碰配置存储；给个最薄的替身就够，测试不该为此落盘
const deadStore = { read: () => ({ config: {} }) };
const deadRuntime = { status: () => ({}) };

async function getPlatforms() {
  const handler = createApiHandler({ configStore: deadStore, runtime: deadRuntime });
  const res = fakeRes();
  await handler({ url: API_PREFIX + '/platforms', method: 'GET' }, res);
  return { json: JSON.parse(res.body()), status: res.statusCode };
}

test('尺寸：size === 4 * version + 17，版本落在 1–10', () => {
  const samples = ['', 'a', OFFICIAL_URL, NAPCAT_URL, 'x'.repeat(60), 'x'.repeat(120), 'x'.repeat(213)];
  for (const text of samples) {
    const qr = encodeQr(text);
    assert.equal(qr.size, qr.version * 4 + 17, '长度 ' + text.length + ' 的样本尺寸对不上');
    assert.ok(qr.version >= 1 && qr.version <= QR_MAX_VERSION, '版本越界：' + qr.version);
  }
});

test('矩阵：size × size 的布尔方阵', () => {
  const qr = encodeQr(OFFICIAL_URL);
  assert.equal(qr.modules.length, qr.size);
  for (const row of qr.modules) {
    assert.equal(row.length, qr.size);
    for (const cell of row) assert.equal(typeof cell, 'boolean');
  }
});

test('定位图形：三角落 7 × 7（外框黑、白环、3 × 3 黑心），外侧留浅色分隔带', () => {
  const qr = encodeQr(OFFICIAL_URL);
  const size = qr.size;
  const corners = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0]
  ];
  for (const [top, left] of corners) {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(qr.modules[top + r][left + c], ring || core, '定位图形 (' + (top + r) + ',' + (left + c) + ') 画错了');
      }
    }
  }
  // 分隔带：定位图形外侧那一行/列必须是浅色，扫码器靠它把图案认出来
  for (let i = 0; i < 8; i += 1) {
    assert.equal(qr.modules[7][i], false);
    assert.equal(qr.modules[i][7], false);
    assert.equal(qr.modules[size - 8][i], false);
    assert.equal(qr.modules[7][size - 1 - i], false);
  }
});

test('时序图形：第 6 行 / 第 6 列在定位图形之间深浅交替', () => {
  for (const text of [OFFICIAL_URL, NAPCAT_URL, 'x'.repeat(120)]) {
    const qr = encodeQr(text);
    for (let i = 8; i < qr.size - 8; i += 1) {
      const expected = i % 2 === 0;
      assert.equal(qr.modules[6][i], expected, '第 6 行第 ' + i + ' 列不是交替的');
      assert.equal(qr.modules[i][6], expected, '第 6 列第 ' + i + ' 行不是交替的');
    }
  }
});

test('确定性：同一输入两次编码完全一致', () => {
  const a = encodeQr(OFFICIAL_URL);
  const b = encodeQr(OFFICIAL_URL);
  assert.equal(a.version, b.version);
  assert.equal(a.mask, b.mask);
  assert.deepEqual(a.modules, b.modules);
});

test('区分度：不同输入给出不同矩阵', () => {
  const official = encodeQr(OFFICIAL_URL);
  const napcat = encodeQr(NAPCAT_URL);
  assert.equal(official.size === napcat.size && JSON.stringify(official.modules) === JSON.stringify(napcat.modules), false);
  const tweaked = encodeQr(OFFICIAL_URL + '?');
  assert.equal(JSON.stringify(official.modules) === JSON.stringify(tweaked.modules), false);
});

test('两条真实 URL 都能编出来', () => {
  for (const url of [OFFICIAL_URL, NAPCAT_URL]) {
    const qr = encodeQr(url);
    assert.ok(qr.version >= 1 && qr.version <= QR_MAX_VERSION);
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.ok(darkCount(qr) > 0);
  }
});

test('超容量：抛错而不是截断', () => {
  // 纠错 M + 版本 10 的数据码字上限是 213 字节
  assert.equal(encodeQr('x'.repeat(213)).version, 10);
  assert.throws(() => encodeQr('x'.repeat(214)), /内容超出容量/);
  assert.throws(() => encodeQr('桥'.repeat(72)), /内容超出容量/);
});

test('纠错等级 M、mask 落在 0–7', () => {
  for (const url of [OFFICIAL_URL, NAPCAT_URL]) {
    const qr = encodeQr(url);
    assert.equal(qr.ecLevel, 'M');
    assert.ok(Number.isInteger(qr.mask) && qr.mask >= 0 && qr.mask <= 7, 'mask 越界：' + qr.mask);
  }
});

test('minVersion：可以强制更高的版本，版本信息块随之出现', () => {
  const qr = encodeQr(OFFICIAL_URL, { minVersion: 10 });
  assert.equal(qr.version, 10);
  assert.equal(qr.size, 57);
  // 版本 >= 7 才有 18 位版本信息区（右上 3×6 与左下 6×3），两块内容一致
  const size = qr.size;
  const rightTop = [];
  const leftBottom = [];
  for (let i = 0; i < 18; i += 1) {
    rightTop.push(qr.modules[Math.floor(i / 3)][(i % 3) + size - 11]);
    leftBottom.push(qr.modules[(i % 3) + size - 11][Math.floor(i / 3)]);
  }
  assert.deepEqual(rightTop, leftBottom);
  assert.ok(rightTop.some((cell) => cell === true), '版本信息块不该全是浅色');
});

test('qrToSvg：以 <svg 开头、带 viewBox、rect 条数等于深色模块数', () => {
  const qr = encodeQr(OFFICIAL_URL);
  const svg = qrToSvg(qr.modules, { size: 200, margin: 4 });
  assert.ok(svg.startsWith('<svg'), svg.slice(0, 20));
  assert.ok(svg.includes('viewBox="0 0 ' + (qr.size + 8) + ' ' + (qr.size + 8) + '"'), 'viewBox 要含静区');
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(svg.split('<rect').length - 1, darkCount(qr));
});

test('qrToSvg：底色用 path 画（所以 rect 计数才可信），尺寸与颜色跟着参数走', () => {
  const qr = encodeQr(NAPCAT_URL);
  const svg = qrToSvg(qr.modules, { size: 320, margin: 2, dark: '#123456', light: '#fefefe' });
  assert.ok(svg.includes('width="320"') && svg.includes('height="320"'));
  assert.ok(svg.includes('<path') && svg.includes('fill="#fefefe"'), '底色必须是 path');
  assert.ok(svg.includes('fill="#123456"'), '深色来自参数');
  assert.equal(svg.split('<rect').length - 1, darkCount(qr));
});

test('qrToSvg：非方形矩阵直接抛错，不猜', () => {
  assert.throws(() => qrToSvg([]), /方形/);
  assert.throws(() => qrToSvg([[true, false]]), /方形/);
});

test('GET /platforms：wizardQr 两个键都在，且都是 SVG', async () => {
  const { json, status } = await getPlatforms();
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.platforms) && json.platforms.length > 0, '字段表不能因为加了二维码就丢');
  assert.deepEqual(Object.keys(json.wizardQr).sort(), ['qq-napcat', 'qq-official']);
  for (const key of ['qq-official', 'qq-napcat']) {
    assert.equal(typeof json.wizardQr[key], 'string');
    assert.ok(json.wizardQr[key].startsWith('<svg'), key + ' 不是 SVG');
  }
});

test('GET /platforms：二维码里的内容就是向导那两个地址', async () => {
  const { json } = await getPlatforms();
  assert.deepEqual(Object.keys(WIZARD_QR_TARGETS).sort(), ['qq-napcat', 'qq-official']);
  assert.equal(WIZARD_QR_TARGETS['qq-official'], OFFICIAL_URL);
  assert.equal(WIZARD_QR_TARGETS['qq-napcat'], NAPCAT_URL);
  for (const [platform, url] of Object.entries(WIZARD_QR_TARGETS)) {
    const expected = darkCount(encodeQr(url));
    assert.equal(json.wizardQr[platform].split('<rect').length - 1, expected, platform + ' 的二维码不是这个地址编出来的');
  }
});

test('wizardQrPayload：同一份缓存重复使用，不在每次请求里重算', () => {
  assert.equal(wizardQrPayload(), wizardQrPayload());
});

test('编码失败：省略该平台的键，接口本身不炸', () => {
  assert.deepEqual(buildWizardQr({ broken: 'x'.repeat(300) }), {});
  const mixed = buildWizardQr({ good: NAPCAT_URL, broken: 'x'.repeat(300) });
  assert.deepEqual(Object.keys(mixed), ['good']);
  assert.ok(mixed.good.startsWith('<svg'));
});
