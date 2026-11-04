// 文本 → Perf 合成的 CLI 入口（tools/say_perf.py 打包后调用）。
// stdin: {"text": "...", "pinyin": bool, "sps": number, "seed": number,
//         "timings": [{s,e,syl?,punct?}], "duration": number}
// stdout: Perf JSON（唯一输出；日志走 stderr）
import { synthesizePerf } from '../src/speech';

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const o = JSON.parse(input || '{}');
  if (typeof o.text !== 'string' || !o.text.trim()) {
    console.error('[say-perf] 缺少 text');
    process.exit(2);
  }
  const timings = Array.isArray(o.timings) && o.timings.length
    ? o.timings.filter((t: any) => t && typeof t.s === 'number' && typeof t.e === 'number'
        && t.e > t.s).map((t: any) => ({
          s: t.s, e: t.e,
          ...(typeof t.syl === 'string' && t.syl ? { syl: t.syl } : {}),
          ...(typeof t.punct === 'string' && t.punct ? { punct: t.punct } : {}),
        }))
    : undefined;
  if (Array.isArray(o.timings) && o.timings.length && (!timings || !timings.length)) {
    console.error('[say-perf] timings 全部非法（需要 s/e 秒且 e>s）');
    process.exit(2);
  }
  const perf = synthesizePerf(o.text, {
    pinyin: !!o.pinyin,
    sps: typeof o.sps === 'number' && o.sps > 0.5 && o.sps < 20 ? o.sps : undefined,
    seed: typeof o.seed === 'number' ? o.seed : undefined,
    motion: !!o.motion, // 低幅动作轨（阶段 3 第 4 项）：显式开启
    style: o.style && typeof o.style === 'object' ? o.style : undefined, // 角色风格（隐含 motion）
    timings,
    duration: typeof o.duration === 'number' && o.duration > 0 ? o.duration : undefined,
  });
  process.stdout.write(JSON.stringify(perf));
});
