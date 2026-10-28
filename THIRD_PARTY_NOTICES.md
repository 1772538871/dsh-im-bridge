# 第三方代码声明

本仓库零运行时依赖（`package.json` 的 `dependencies` 为空），下面这些代码以**拷贝/裁剪**的方式进入源码，不是 npm 依赖。

## qrcode-generator

- 库名：qrcode-generator（<https://github.com/kazuhikoarase/qrcode-generator>）
- 作者：Kazuhiko Arase
- 许可证：MIT
- 用途：`lib/qr.js` —— 宿主侧生成接入向导的二维码，随 `GET /platforms`（`wizardQr`）下发；`lib/client.js` 是单文件模块包引不到相对路径模块，所以二维码只能在宿主算。
- 裁剪说明：只保留本项目实际走到的路径 ——
  - 只支持**字节模式**（`0100`），不做数字/字母数字/汉字模式；
  - 只支持**纠错等级 M**，L/Q/H 的分块表与格式位全部删掉；
  - 只支持**版本 1–10**（容量 213 字节），11–40 的分块表、对齐表、掩码惩罚之外的常量全部删掉；
  - 只保留 `encodeQr(text, opts) -> { version, size, mask, ecLevel, modules }` 与 `qrToSvg(modules, opts) -> string` 两个出口，不提供 DOM/画布写入；
  - 自带最小掩码选择（四条惩罚规则）与 SVG 序列化，原库的 `createImgTag` / `createSvgTag` / GIF 渲染部分未移植；
  - 容量不足时抛错，不做截断（截断后仍能扫，但扫出来的是错的内容）。
- 版权头：`lib/qr.js` 顶部保留作者与 MIT 出处声明。

## jsQR（仅用于验证，未进源码）

- 库名：jsQR（<https://github.com/cozmo/jsQR>）· 作者：Cosmo Wolfe · 许可证：Apache-2.0
- 用途：仅在交付自证里一次性 `fetch` 它的 UMD 包、在 Node 里解码 `encodeQr()` 的输出，证明二维码真的能扫出来。
- 它**不**出现在 `package.json`、不进仓库、不参与运行时或 `node --test`。
