import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Config } from "@remotion/cli/config";

// Remotion 将配置打包为 CJS 后执行，因此这里以调用目录定位仓库。
// 支持在仓库根、studio/ 目录，或 Python CLI 中启动。
const cwd = process.cwd();
const repositoryRoot = fs.existsSync(path.resolve(cwd, "packages"))
  ? cwd
  : path.resolve(cwd, "..");
const CORE = path.resolve(repositoryRoot, "packages/anchor-core/src/index.ts");
if (!fs.existsSync(CORE)) {
  throw new Error(
    `[codeavatar] 找不到 @anchor/core：${CORE}\n` +
      `请从仓库根目录或 studio/ 目录执行 Remotion`
  );
}

// 浏览器显式解析：Remotion 默认从 storage.googleapis.com 在线下载
// Chrome Headless Shell，网络受限环境会永久挂起（无超时、无报错）。
// 优先级与 tools/codeavatar.py 的 find_browser() 保持一致：
//   CODEAVATAR_BROWSER 环境变量 → node_modules/.remotion 缓存 → 系统 Chrome/Edge
// 都找不到时不设置，走 Remotion 默认下载（并在 stderr 打印一行告警）。
const findBrowser = (): string | null => {
  const envBrowser = process.env.CODEAVATAR_BROWSER;
  if (envBrowser) {
    if (fs.existsSync(envBrowser) && fs.statSync(envBrowser).isFile()) {
      return envBrowser;
    }
    throw new Error(
      `[codeavatar] CODEAVATAR_BROWSER=${envBrowser} 不是可执行文件路径`
    );
  }

  const candidates: string[] = [];
  const cacheDir = path.join(repositoryRoot, "node_modules", ".remotion");
  if (fs.existsSync(cacheDir)) {
    const stack = [cacheDir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (/^chrome-headless-shell(\.exe)?$/.test(entry.name)) {
          candidates.push(full);
        }
      }
    }
  }
  if (os.platform() === "win32") {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const lad = process.env.LocalAppData;
    candidates.push(
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe")
    );
    if (lad) {
      candidates.push(path.join(lad, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else {
    for (const name of ["google-chrome", "chromium", "chrome", "msedge"]) {
      try {
        candidates.push(execFileSync("which", [name], { encoding: "utf-8" }).trim());
      } catch {
        // PATH 里没有该命令，跳过
      }
    }
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.statSync(c).isFile()) {
      return c;
    }
  }
  return null;
};

const browser = findBrowser();
if (browser) {
  process.stderr.write(`[codeavatar] 渲染浏览器: ${browser}\n`);
  Config.setBrowserExecutable(browser);
} else {
  process.stderr.write(
    "[codeavatar] ⚠ 未找到本地浏览器，Remotion 将在线下载 Chrome Headless Shell" +
      "（网络受限时会挂起；可用 CODEAVATAR_BROWSER=<浏览器路径> 显式指定）\n"
  );
}

Config.setVideoImageFormat("jpeg");
Config.setConcurrency(1); // 本机 3.7G 内存，双并发会 OOM
Config.setChromiumOpenGlRenderer("swangle");
Config.overrideWebpackConfig((cfg) => ({
  ...cfg,
  resolve: {
    ...cfg.resolve,
    alias: {
      ...(cfg.resolve?.alias ?? {}),
      "@anchor/core": CORE,
    },
    // core 在 studio 之外，它 import 的 react/remotion 要用 studio 的依赖。
    // ⚠ 第一项必须是 'node_modules'（默认值，会逐级向上查找）：
    //   只写绝对路径会把默认解析规则整个替换掉，根 node_modules 里 hoist 的包就找不到了
    //   （实测症状：Can't resolve 'mediabunny' in @remotion/studio）
    modules: ['node_modules', path.resolve(repositoryRoot, 'node_modules')],
  },
}));
