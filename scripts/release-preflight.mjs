#!/usr/bin/env node
/**
 * 发布前检查与发布后校验。
 *
 * 0.1.0 曾因 2FA 触发 npm staged publishing, packument 的 readme 与
 * readmeFilename 落成空字符串, 导致包进不了 npm search 索引, pi.dev/packages
 * 也查不到。本脚本把这条教训固化成两步检查:
 *
 *   node scripts/release-preflight.mjs          发布前检查(不需要网络写权限)
 *   node scripts/release-preflight.mjs --verify 发布后校验 registry 元数据
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org";

/** 打包后必须存在的文件, 缺任意一个都说明 files 配置有问题。 */
const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "extensions/wechat-session-hub.ts",
  "extensions/daemon-entry.mjs",
  "src/runtime/gateway-daemon.ts",
];

const failures = [];
const notes = [];

/**
 * 记录一条失败原因。
 *
 * @param {string} message 失败说明。
 * @returns {void}
 */
function fail(message) {
  failures.push(message);
}

/**
 * 记录一条提示信息。
 *
 * @param {string} message 提示说明。
 * @returns {void}
 */
function note(message) {
  notes.push(message);
}

/**
 * 读取本地 package.json。
 *
 * @returns {Record<string, unknown>} 解析后的清单对象。
 */
function readManifest() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
}

/**
 * 请求 registry 的 packument, 不存在时返回 undefined。
 *
 * @param {string} name 包名。
 * @returns {Promise<Record<string, unknown> | undefined>} packument 或 undefined。
 */
async function fetchPackument(name) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { "user-agent": "pi-wechat-session-hub-release-check" },
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`registry 返回 ${response.status}`);
  }
  return await response.json();
}

/**
 * 执行发布前检查。
 *
 * @returns {Promise<void>} 检查完成后返回。
 */
async function runPreflight() {
  const manifest = readManifest();
  const { name, version, keywords, files, dependencies, pi } = manifest;

  if (!Array.isArray(keywords) || !keywords.includes("pi-package")) {
    fail("keywords 缺少 pi-package, 包不会出现在 pi.dev/packages");
  }
  if (!pi || !Array.isArray(pi.extensions) || pi.extensions.length === 0) {
    fail("package.json 缺少 pi.extensions 清单");
  }
  if (!dependencies || !dependencies.jiti) {
    fail("dependencies 缺少 jiti, npm 安装后 daemon 启动垫片会加载失败");
  }
  if (!Array.isArray(files) || !files.includes("CHANGELOG.md")) {
    note("files 未包含 CHANGELOG.md, 更新日志不会进入 tarball");
  }

  const packed = JSON.parse(
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    }),
  )[0];
  const packedPaths = new Set(packed.files.map((entry) => entry.path));
  for (const required of REQUIRED_FILES) {
    if (!packedPaths.has(required)) {
      fail(`tarball 缺少 ${required}`);
    }
  }
  note(`tarball 含 ${packed.entryCount} 个文件, ${(packed.size / 1024).toFixed(1)} KiB`);

  const packument = await fetchPackument(name);
  if (!packument) {
    note(`${name} 在 registry 上尚不存在, 本次为首次发布`);
  } else {
    const published = packument.versions?.[version];
    if (published) {
      fail(`版本 ${version} 已存在于 registry, 请先提升版本号`);
    }
    const latest = packument["dist-tags"]?.latest;
    note(`registry 当前 latest 为 ${latest}, 本地待发布 ${version}`);
  }

  report();
}

/**
 * 发布后校验 registry 元数据, 重点验证 0.1.0 踩过的 readme 空值问题。
 *
 * @returns {Promise<void>} 校验完成后返回。
 */
async function runVerify() {
  const manifest = readManifest();
  const { name, version } = manifest;

  const packument = await fetchPackument(name);
  if (!packument) {
    fail(`${name} 在 registry 上不存在`);
    report();
    return;
  }

  const published = packument.versions?.[version];
  if (!published) {
    const rawVersions = Object.keys(packument.versions ?? {});
    if (rawVersions.includes("0.0.0-stage") || packument["dist-tags"]?.latest !== version) {
      fail(`registry 上暂时看不到 ${version}: npm 可能正在做发布后安全扫描(网页显示 Validating), 稍等几分钟后重试`);
    } else {
      fail(`registry 上找不到 ${version}, 发布可能尚未生效`);
    }
    report();
    return;
  }

  // 版本级 readme 在正常发布的包里也常为空, 真正影响搜索索引的是顶层 readme,
  // 因此只在顶层也为空时判失败, 避免误报。
  const packumentReadme = typeof packument.readme === "string" ? packument.readme : "";
  const versionReadme = typeof published.readme === "string" ? published.readme : "";
  if (packumentReadme.trim().length === 0) {
    fail("顶层 readme 为空, 该包可能无法进入 npm search 索引(0.1.0 的同款问题)");
  } else {
    const versionNote = versionReadme.trim().length === 0 ? "(版本级为空属正常)" : "";
    note(`顶层 readme ${packumentReadme.length} 字符, 版本级 readme ${versionReadme.length} 字符${versionNote}`);
  }

  const latest = packument["dist-tags"]?.latest;
  if (latest !== version) {
    fail(`dist-tags.latest 是 ${latest}, 与本地版本 ${version} 不一致`);
  } else {
    note(`dist-tags.latest = ${version}`);
  }

  const searchHit = await checkNpmSearch(name).catch((error) => {
    note(`npm search 检查跳过: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  if (searchHit === true) {
    note("npm search 已能检索到该包");
  } else if (searchHit === false) {
    note("npm search 暂未收录, 索引有延迟, 通常几分钟到数小时");
  }

  const galleryHit = await checkGallery(name).catch((error) => {
    note(`pi.dev/packages 检查跳过: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  if (galleryHit === true) {
    note("pi.dev/packages 已能搜到该包");
  } else if (galleryHit === false) {
    note("pi.dev/packages 暂未收录, 站点有自己的索引缓存, 需要等待刷新");
  }

  report();
}

/**
 * 查询 npm search 是否已收录该包。
 *
 * @param {string} name 包名。
 * @returns {Promise<boolean>} 已收录返回 true, 未收录返回 false。
 */
async function checkNpmSearch(name) {
  const response = await fetchWithTimeout(
    `${REGISTRY}/-/v1/search?text=${encodeURIComponent(`${name} keywords:pi-package`)}&size=20`,
  );
  if (!response.ok) {
    throw new Error(`search 接口返回 ${response.status}`);
  }
  const result = await response.json();
  return Boolean(result.objects?.some((item) => item.package?.name === name));
}

/**
 * 查询 pi.dev 包画廊是否已收录该包。
 *
 * @param {string} name 包名。
 * @returns {Promise<boolean>} 已收录返回 true, 未收录返回 false。
 */
async function checkGallery(name) {
  const response = await fetchWithTimeout(`https://pi.dev/packages?name=${encodeURIComponent(name)}`);
  if (!response.ok) {
    throw new Error(`pi.dev 返回 ${response.status}`);
  }
  const html = await response.text();
  return html.includes(name);
}

/**
 * 带超时的 fetch。
 *
 * 外部站点(尤其是经 Cloudflare 的 pi.dev)在网络受限时可能长时间不响应,
 * 必须显式限时, 否则会拖住整个校验流程。
 *
 * @param {string} url 请求地址。
 * @returns {Promise<Response>} 响应对象。
 */
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(url, {
      headers: { "user-agent": "pi-wechat-session-hub-release-check" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 输出结果并按失败情况设置退出码。
 *
 * @returns {void}
 */
function report() {
  for (const message of notes) {
    console.log(`  · ${message}`);
  }
  if (failures.length === 0) {
    console.log("\n检查通过");
    return;
  }
  console.error("");
  for (const message of failures) {
    console.error(`  ✗ ${message}`);
  }
  console.error(`\n${failures.length} 项检查未通过`);
  process.exitCode = 1;
}

const isVerify = process.argv.includes("--verify");
console.log(isVerify ? "发布后校验" : "发布前检查");
await (isVerify ? runVerify() : runPreflight());
