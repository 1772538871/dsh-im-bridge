/**
 * 把 Markdown / 模型习惯的输出压成"QQ 里好看"的纯文本。
 * QQ 不渲染任何 markdown：### 会原样显示成井号、** 会变成星号、表格会满屏竖线，
 * 所以这里做一次有损但可读的转换，而不是让用户看一堆符号。
 */
// 一眼就能看出是 AI 的套话：整行删掉（改写容易留下半句怪话）
// 两类：① 整行就是套话；② 短行里含特定套话（长正文里提到这些词不动）
const BOILERPLATE_PURE = /^(以上|以上全部|总之|综上|总而言之|总的来说|就这些|先这样|先到这|完毕|结束|祝好|敬礼|希望对你有所帮助|希望对你有帮助|希望能帮到你|希望这些对你有帮助){1,3}$/u;
const BOILERPLATE_IN_SHORT = [
  /希望(这|以上)?(对你|对您)?(有|能)(所)?(帮助|用)/u,
  /(还有|如|若)(其他|其它|别的|什么|啥)?(问题|需要|疑问|要问|吩咐)/u,
  /还需要我(做|帮|干)/u,
  /需要我(做|帮|干)(什么|啥)/u,
  /(如果|要是)(还)?(需要|想要)我/u,
  /祝你(今天|一切|生活|工作)/u
];
const SHORT_LINE_MAX = 40;

function dropBoilerplate(text) {
  const kept = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // 压掉标点后如果整行只剩套话，就丢掉（「总之，先这样。」这种组合也能命中）
    if (trimmed !== "" && BOILERPLATE_PURE.test(trimmed.replace(/[，,。.!！~～、;；:：\s]/gu, ""))) continue;
    if (trimmed !== "" && trimmed.length <= SHORT_LINE_MAX && BOILERPLATE_IN_SHORT.some((pattern) => pattern.test(trimmed))) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export function formatForQq(input) {
  if (typeof input !== "string") return "";
  let s = input.replace(/\r\n?/g, "\n");
  if (s.trim() === "") return "";

  // 代码围栏：QQ 不渲染，围栏本身纯属噪音，保留里面的内容
  s = s.replace(/^[ \t]*```[a-zA-Z0-9_+-]*[ \t]*$/gm, "");

  // 标题 -> ▍标题（一眼能看出层级，又不占两行）
  s = s.replace(/^[ \t]*#{1,6}[ \t]+([^\n]+?)[ \t]*$/gm, "▍$1");

  // 加粗 / 下划线强调 / 行内代码
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");

  // 无序列表统一成 ·，有序列表统一成 "1. "
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, "· ");
  s = s.replace(/^[ \t]*(\d+)[.)][ \t]+/gm, "$1. ");

  // 引用块
  s = s.replace(/^[ \t]*>[ \t]?/gm, "｜");

  // 水平线整行删掉
  s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "");

  // 表格：把 | a | b | 压成 "· a ｜ b"，分隔线整行删掉
  s = s.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, inner) => "· " + String(inner).split("|").map((c) => c.trim()).filter(Boolean).join(" ｜ "));
  s = s.replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, "");

  // 行尾空白清掉，并且**把空行全部压掉**：聊天窗口里空行一眼就像机器人写的模板
  s = s.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
  s = s.replace(/\n{2,}/g, "\n").trim();
  s = dropBoilerplate(s).replace(/\n{2,}/g, "\n").trim();
  return s;
}
