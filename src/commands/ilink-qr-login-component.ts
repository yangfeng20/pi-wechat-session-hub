const ANSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/**
 * 在 Pi TUI 中显示临时 iLink QR 和扫码状态。
 */
export class IlinkQrLoginComponent {
  private status: string;
  private qrLines: string[] = [];

  /**
   * 创建二维码登录界面。
   *
   * @param onCancel Escape / Ctrl+C 回调。
   * @param initialStatus 初始化状态。
   */
  constructor(
    private readonly onCancel: () => void,
    initialStatus = "正在连接 iLink 授权服务...",
  ) {
    this.status = initialStatus;
  }

  /**
   * 更新待扫描的终端二维码内容。
   *
   * @param terminalQr ANSI 终端二维码文本。
   * @returns 无返回值。
   */
  setQr(terminalQr: string): void {
    this.qrLines = terminalQr.replace(/\r/g, "").split("\n").filter((line) => line.length > 0);
  }

  /**
   * 更新授权状态提示。
   *
   * @param status 新状态。
   * @returns 无返回值。
   */
  setStatus(status: string): void {
    this.status = status;
  }

  /**
   * 渲染二维码和授权安全提示。
   *
   * @param width 当前 TUI 可用列数。
   * @returns 每行宽度不超过 width 的文本。
   */
  render(width: number): string[] {
    const lines = [
      "Pi Hub 微信授权",
      "请确认该微信/iLink 账号没有被其他客户端同时轮询。",
      "本流程只写入 Pi Hub 自己的 credentials.json, 不读取或修改其他客户端数据。",
      `状态: ${this.status}`,
      "",
    ].map((line) => truncateDisplayWidth(line, width));

    if (this.qrLines.some((line) => displayWidth(line) > width)) {
      lines.push(truncateDisplayWidth("终端宽度不足以完整显示二维码, 请扩大终端后重试.", width));
    } else {
      lines.push(...this.qrLines);
    }
    lines.push("");
    lines.push(truncateDisplayWidth("使用手机微信扫描二维码并确认授权. 按 Esc 取消.", width));
    return lines;
  }

  /**
   * 处理用户取消按键。
   *
   * @param data TUI 输入序列。
   * @returns Escape 或 Ctrl+C 时调用 onCancel。
   */
  handleInput(data: string): void {
    if (data === "\u001b" || data === "\u0003") {
      this.onCancel();
    }
  }

  /**
   * 当前组件不缓存渲染内容, 无需额外处理 theme invalidate。
   *
   * @returns 无返回值。
   */
  invalidate(): void {}
}

/**
 * 计算去除 ANSI 控制码后的终端显示宽度。
 *
 * @param value 待测文本。
 * @returns 估算的终端列宽。
 */
function displayWidth(value: string): number {
  return Array.from(value.replace(ANSI_SEQUENCE, "")).reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return width + (isWideCharacter(codePoint) ? 2 : codePoint < 0x20 ? 0 : 1);
  }, 0);
}

/**
 * 将文本按终端列宽截断, 保证渲染行不越界。
 *
 * @param value 待截断文本。
 * @param maxWidth 最大终端列宽。
 * @returns 宽度不超过 maxWidth 的文本。
 */
function truncateDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  let output = "";
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const characterWidth = isWideCharacter(codePoint) ? 2 : 1;
    if (width + characterWidth > maxWidth) {
      break;
    }
    output += character;
    width += characterWidth;
  }
  return output;
}

/**
 * 识别常见的 CJK 和 emoji wide code points。
 *
 * @param codePoint Unicode code point。
 * @returns 字符通常占用两列时返回 true。
 */
function isWideCharacter(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 || codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}
