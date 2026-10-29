/**
 * 把 Markdown / 模型习惯的输出压成"QQ 里好看"的纯文本。
 * QQ 不渲染任何 markdown：### 会原样显示成井号、** 会变成星号、表格会满屏竖线，
 * 所以这里做一次有损但可读的转换，而不是让用户看一堆符号。
 */
// 一眼就能看出是 AI 的套话：整行删掉，而不是改写（改写容易留下半句怪话）
const BOILERPLATE_LINE = [
  /^(希望|但愿)(这|以上)?(对你|对您)?(有|能)(所)?(帮助|用)/u,
  /^(以上|就这些|先这样|总之|综上|总的来说)[，,。]?$/u,
  /^(如|若)(有)?(其他|其它|还有)?(问题|需要|疑问)/u,
  /^(还|另有)(有)?(什么|啥)?(需要|问题|要问)(我)?(吗|呢)/u,
  /^(祝|愿你)/u,
  /^(如果)(你|您|需要我)?(还)?(想|要)/u
];

function dropBoilerplate(text) {
  const kept = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // 只删"独立成行"的套话；正文里提到这些词不动
    if (trimmed !== "" && BOILERPLATE_LINE.some((pattern) => pattern.test(trimmed))) continue;
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
