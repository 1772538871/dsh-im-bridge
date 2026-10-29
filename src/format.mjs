/**
 * 把 Markdown / 模型习惯的输出压成"QQ 里好看"的纯文本。
 * QQ 不渲染任何 markdown：### 会原样显示成井号、** 会变成星号、表格会满屏竖线，
 * 所以这里做一次有损但可读的转换，而不是让用户看一堆符号。
 */
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
  return s;
}
