/**
 * 面向用户与模型的文案语言。
 *
 * 桌面端的界面语言（英文/中文）通过 `app.setLanguage` 告诉服务；服务里凡是会显示给用户、
 * 或写进模型可见文本（工具结果、`[SYSTEM NOTE]`）的消息，都用 `say(英文, 中文)` 成对给出。
 * 默认英文：没有桌面端连接时（测试、命令行）不应出现中文。
 *
 * 不用词条表：文案紧挨着调用点，增删一条不会漏改另一处；两份文案各自带插值，
 * 所以实参会被求值两次，调用点不要放有副作用的表达式。
 */

export type Lang = "en" | "zh";

let current: Lang = "en";

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "zh";
}

export function setLanguage(lang: Lang): void {
  current = lang;
}

export function language(): Lang {
  return current;
}

/** 按当前语言取文案。 */
export function say(en: string, zh: string): string {
  return current === "zh" ? zh : en;
}
