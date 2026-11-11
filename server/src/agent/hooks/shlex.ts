/**
 * Port of CPython 3.11 `shlex.split(text)` with `comments=False, posix=True`.
 *
 * A condition clause and a command hook both go through `shlex.split`, so the quote and backslash rules are part of
 * the hook contract: single quotes are literal, double quotes honour `\"` and `\\` only, unquoted backslash escapes the
 * next character, an empty quoted string is a token, and an unterminated quote or trailing backslash raises.
 * `punctuation_chars` is off and `commenters` is empty, so the only states are whitespace, word, quote and escape.
 */

/** A `ValueError` from Python's lexer: "No closing quotation" or "No escaped character". */
export class ShlexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShlexError";
  }
}

type State = " " | "a" | "'" | '"' | "\\" | null;

/** `shlex.split(text)`; `posix` is false only for command hooks on Windows, which is what Python does there. */
export function shlexSplit(text: string, posix = true): string[] {
  let position = 0;
  let state: State = " ";
  let token = "";

  const readToken = (): string | null => {
    let quoted = false;
    let escapedState = " ";
    scan: for (;;) {
      const nextchar = position < text.length ? text[position++]! : "";
      if (state === null) {
        token = "";
        break scan;
      }
      if (state === " ") {
        if (nextchar === "") {
          state = null;
          break scan;
        }
        if (nextchar === " " || nextchar === "\t" || nextchar === "\r" || nextchar === "\n") {
          if (token !== "" || quoted) break scan;
          continue;
        }
        if (posix && nextchar === "\\") {
          escapedState = "a";
          state = "\\";
          continue;
        }
        if (nextchar === "'" || nextchar === '"') {
          if (!posix) token = nextchar;
          state = nextchar;
          continue;
        }
        // whitespace_split is always on for `split()`, so any other character starts a word.
        token = nextchar;
        state = "a";
        continue;
      }
      if (state === "'" || state === '"') {
        quoted = true;
        if (nextchar === "") throw new ShlexError("No closing quotation");
        if (nextchar === state) {
          if (!posix) {
            token += nextchar;
            state = " ";
            break scan;
          }
          state = "a";
          continue;
        }
        if (posix && nextchar === "\\" && state === '"') {
          escapedState = state;
          state = "\\";
          continue;
        }
        token += nextchar;
        continue;
      }
      if (state === "\\") {
        if (nextchar === "") throw new ShlexError("No escaped character");
        // Inside quotes only the closing quote and the escape character may be escaped.
        if ((escapedState === "'" || escapedState === '"') && nextchar !== "\\" && nextchar !== escapedState) {
          token += "\\";
        }
        token += nextchar;
        state = escapedState as State;
        continue;
      }
      // state === "a": the token continues until whitespace, a quote or an escape.
      if (nextchar === "") {
        state = null;
        break scan;
      }
      if (nextchar === " " || nextchar === "\t" || nextchar === "\r" || nextchar === "\n") {
        state = " ";
        if (token !== "" || quoted) break scan;
        continue;
      }
      if (posix && (nextchar === "'" || nextchar === '"')) {
        state = nextchar;
        continue;
      }
      if (posix && nextchar === "\\") {
        escapedState = "a";
        state = "\\";
        continue;
      }
      token += nextchar;
    }

    const result = token;
    token = "";
    return posix ? (quoted || result !== "" ? result : null) : result === "" ? null : result;
  };

  const tokens: string[] = [];
  for (;;) {
    const item = readToken();
    if (item === null) break;
    tokens.push(item);
  }
  return tokens;
}
