export class CommandTokenizeError extends Error {
  /**
   * 创建命令分词错误。
   *
   * @param message 面向用户的中文错误信息。
   */
  constructor(message: string) {
    super(message);
    this.name = "CommandTokenizeError";
  }
}

/**
 * 按单引号和双引号分词, 不执行 shell expansion。
 *
 * @param input 原始命令行参数。
 * @returns 分词结果。
 * @throws {CommandTokenizeError} 引号未闭合时抛出。
 */
export function tokenizeCommandArguments(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
        tokenStarted = true;
      } else if (
        quote === '"' &&
        character === "\\" &&
        (input[index + 1] === '"' || input[index + 1] === "\\")
      ) {
        current += input[index + 1];
        index += 1;
        tokenStarted = true;
      } else {
        current += character;
        tokenStarted = true;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (quote) {
    throw new CommandTokenizeError("命令参数中的引号未闭合。");
  }
  if (tokenStarted) {
    tokens.push(current);
  }
  return tokens;
}
