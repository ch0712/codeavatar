import fs from "fs";
import path from "path";
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
