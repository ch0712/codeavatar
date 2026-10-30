import fs from "fs";
import path from "path";
import { Config } from "@remotion/cli/config";

// 定位方式说明（踩过的坑）：
//  · `__dirname` 在 config 里指向 @remotion/cli/dist（Remotion 把配置打成 CJS 再执行）
//  · `import.meta` 在 CJS 下直接为空串（会报 "import.meta is not available with the cjs output format"）
// → 只能用 process.cwd()，并断言路径存在（找不到就 fail loud，不静默降级）
const CORE = path.resolve(process.cwd(), "../packages/anchor-core/src/index.ts");
if (!fs.existsSync(CORE)) {
  throw new Error(
    `[codeavatar] 找不到 @anchor/core：${CORE}\n` +
      `remotion 必须在 studio/ 目录下执行（npm run render 已处理；直接调 npx 时请先 cd studio）`
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
    modules: ['node_modules', path.resolve(process.cwd(), 'node_modules')],
  },
}));
