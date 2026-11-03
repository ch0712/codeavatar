// Performance schema 契约与校验（阶段 1 / ROADMAP §4-1 第 1+2 项）。
//
// 之前 Perf 是"约定俗成"：字段含义靠注释、范围靠渲染端各处硬编码 clamp、
// 契约外值静默通过。本文件给出机器可校验的契约：
//
//   PERF_SCHEMA_VERSION —— 契约版本（破坏性变更递增，附迁移说明）
//   validatePerf()      —— 结构化校验：返回错误列表 [{path, code, message}]，
//                          不抛异常、不静默修正（调用方决定报错/拒绝）
//   perfContractJson()  —— 契约的 JSON 序列化（Python 侧共享的机器校验源，
//                          由 scripts/schema-dump.ts 固化入库 + CI 同步断言）
//
// 范围语义：PerfFrame 字段范围 = poseAt 实际渲染行为（含 clamp 边界）。
import { POSE_RANGES, Viseme } from './types';
import { INTENT_VA } from './intent';

export const PERF_SCHEMA_VERSION = 1;

const VISEMES: ReadonlyArray<Viseme> = ['M', 'A', 'O', 'E', 'I', 'U'];
const INTENTS = Object.keys(INTENT_VA);

export type PerfError = { path: string; code: string; message: string };
export type PerfResult = { ok: boolean; errors: PerfError[]; schemaVersion: number };

const MAX_ERRORS = 50;

const err = (errors: PerfError[], path: string, code: string, message: string) => {
  if (errors.length < MAX_ERRORS) errors.push({ path, code, message });
};

const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** 区间校验：outside → 返回错误 */
const range = (
  errors: PerfError[], path: string, v: unknown, lo: number, hi: number, code = 'E_RANGE',
) => {
  if (!isNum(v)) {
    err(errors, path, 'E_TYPE', `期望数值，得到 ${typeof v}`);
    return false;
  }
  if (v < lo || v > hi) {
    err(errors, path, code, `值 ${v} 超出契约范围 [${lo}, ${hi}]`);
    return false;
  }
  return true;
};

/**
 * 校验 Perf 对象。frame 字段范围与 poseAt 渲染行为一致：
 *   o/env ∈ [0,1]（音节包络）、br ∈ [-1,1]（眉偏移）、nd ∈ [-1,1]（点头）、
 *   gz ∈ [-1,1]²（画幅相对视线）、m ∈ 六口型。
 * 可选轨（intent/motion/meta）存在时按各自契约校验。
 */
export const validatePerf = (p: unknown): PerfResult => {
  const errors: PerfError[] = [];
  if (typeof p !== 'object' || p === null) {
    return { ok: false, errors: [{ path: '$', code: 'E_TYPE', message: 'Perf 必须是对象' }], schemaVersion: PERF_SCHEMA_VERSION };
  }
  const perf = p as Record<string, unknown>;

  // 版本：缺省按当前版本；显式给出且更高 → 拒绝（旧代码不认识新契约）
  const v = perf.v ?? PERF_SCHEMA_VERSION;
  if (v !== PERF_SCHEMA_VERSION) {
    err(errors, '$.v', 'E_SCHEMA_VERSION',
      `schema 版本 ${v} 不受支持（当前 ${PERF_SCHEMA_VERSION}）`);
  }

  // fps / duration / frames
  if (!range(errors, '$.fps', perf.fps, 1, 240)) {
    // fps 非法时后续依赖帧率的检查跳过
  } else if (!Number.isInteger(perf.fps)) {
    err(errors, '$.fps', 'E_TYPE', 'fps 必须是整数');
  }
  if (!Array.isArray(perf.frames) || perf.frames.length === 0) {
    err(errors, '$.frames', 'E_MISSING', 'frames 必须是非空数组');
  } else {
    const frames = perf.frames as unknown[];
    frames.forEach((f, i) => {
      const path = `$.frames[${i}]`;
      if (typeof f !== 'object' || f === null) {
        err(errors, path, 'E_TYPE', '帧必须是对象');
        return;
      }
      const fr = f as Record<string, unknown>;
      if (!VISEMES.includes(fr.m as Viseme)) {
        err(errors, `${path}.m`, 'E_ENUM', `口型必须是 ${VISEMES.join('/')}，得到 ${JSON.stringify(fr.m)}`);
      }
      range(errors, `${path}.o`, fr.o, 0, 1);
      range(errors, `${path}.env`, fr.env, 0, 1);
      range(errors, `${path}.br`, fr.br, -1, 1);
      range(errors, `${path}.nd`, fr.nd, -1, 1);
      if (Array.isArray(fr.gz) && fr.gz.length === 2) {
        range(errors, `${path}.gz[0]`, fr.gz[0], -1, 1);
        range(errors, `${path}.gz[1]`, fr.gz[1], -1, 1);
      } else {
        err(errors, `${path}.gz`, 'E_TYPE', 'gz 必须是二元数值数组');
      }
    });
    // duration ≈ frames.length / fps（容差 1 帧）
    if (isNum(perf.fps) && isNum(perf.duration) && Number.isInteger(perf.fps)) {
      const expect = frames.length / (perf.fps as number);
      if (Math.abs((perf.duration as number) - expect) > 1 / (perf.fps as number)) {
        err(errors, '$.duration', 'E_INCONSISTENT',
          `duration ${perf.duration} 与 frames.length/fps = ${expect.toFixed(4)} 不符（容差 1 帧）`);
      }
    }
  }

  // gestures
  if (Array.isArray(perf.gestures)) {
    (perf.gestures as unknown[]).forEach((g, i) => {
      const path = `$.gestures[${i}]`;
      if (typeof g !== 'object' || g === null) {
        err(errors, path, 'E_TYPE', '手势必须是对象');
        return;
      }
      const o = g as Record<string, unknown>;
      if (isNum(o.t) && isNum(o.t1) && o.t1 < o.t) {
        err(errors, `${path}.t1`, 'E_INCONSISTENT', `t1 ${o.t1} < t ${o.t}`);
      }
    });
  } else {
    err(errors, '$.gestures', 'E_MISSING', 'gestures 必须是数组（可为空）');
  }

  // intent 轨（可选）
  if (perf.intent !== undefined) {
    const it = perf.intent as Record<string, unknown>;
    if (!Array.isArray(it.spans)) {
      err(errors, '$.intent.spans', 'E_MISSING', 'intent.spans 必须是数组');
    } else {
      (it.spans as unknown[]).forEach((s, i) => {
        const path = `$.intent.spans[${i}]`;
        if (typeof s !== 'object' || s === null) {
          err(errors, path, 'E_TYPE', '意图 span 必须是对象');
          return;
        }
        const o = s as Record<string, unknown>;
        if (!INTENTS.includes(o.intent as string)) {
          err(errors, `${path}.intent`, 'E_ENUM', `意图必须是 ${INTENTS.join('/')}，得到 ${JSON.stringify(o.intent)}`);
        }
        range(errors, `${path}.intensity`, o.intensity ?? 0.8, 0, 1);
        if (isNum(o.t) && isNum(o.t1) && o.t1 < o.t) {
          err(errors, `${path}.t1`, 'E_INCONSISTENT', `t1 ${o.t1} < t ${o.t}`);
        }
      });
    }
  }

  // motion 轨（可选）——范围与渲染端 clamp 一致
  if (perf.motion !== undefined) {
    const mo = perf.motion as Record<string, unknown>;
    const gazes = (mo.gaze as Record<string, unknown> | undefined)?.spans;
    if (gazes !== undefined) {
      if (!Array.isArray(gazes)) err(errors, '$.motion.gaze.spans', 'E_MISSING', 'gaze.spans 必须是数组');
      else (gazes as unknown[]).forEach((s, i) => {
        const path = `$.motion.gaze.spans[${i}]`;
        const o = s as Record<string, unknown>;
        const t = o.target as Record<string, unknown> | undefined;
        if (typeof t !== 'object' || t === null) {
          err(errors, `${path}.target`, 'E_TYPE', 'gaze target 必须是对象');
          return;
        }
        range(errors, `${path}.target.x`, t.x, POSE_RANGES.gazeX[0], POSE_RANGES.gazeX[1]);
        range(errors, `${path}.target.y`, t.y, POSE_RANGES.gazeY[0], POSE_RANGES.gazeY[1]);
      });
    }
    const blinks = (mo.blink as Record<string, unknown> | undefined)?.events;
    if (blinks !== undefined) {
      if (!Array.isArray(blinks)) err(errors, '$.motion.blink.events', 'E_MISSING', 'blink.events 必须是数组');
      else (blinks as unknown[]).forEach((e, i) => {
        const o = e as Record<string, unknown>;
        range(errors, `$.motion.blink.events[${i}].amp`, o.amp ?? 1, 0, 1);
        range(errors, `$.motion.blink.events[${i}].rate`, o.rate ?? 2, 0, 10);
      });
    }
    const heads = (mo.head as Record<string, unknown> | undefined)?.spans;
    if (heads !== undefined) {
      if (!Array.isArray(heads)) err(errors, '$.motion.head.spans', 'E_MISSING', 'head.spans 必须是数组');
      else (heads as unknown[]).forEach((s, i) => {
        const o = s as Record<string, unknown>;
        const r = (k: 'yaw' | 'tilt' | 'nod') => {
          if (o[k] !== undefined) range(errors, `$.motion.head.spans[${i}].${k}`, o[k], -1, 1);
        };
        r('yaw'); r('tilt'); r('nod');
      });
    }
    const breath = mo.breath as Record<string, unknown> | undefined;
    if (breath !== undefined) {
      range(errors, '$.motion.breath.bpm', breath.bpm ?? 14, 4, 40);
    }
  }

  return { ok: errors.length === 0, errors, schemaVersion: PERF_SCHEMA_VERSION };
};

/** 契约的 JSON 序列化：Python 侧共享的机器校验源（scripts/schema-dump.ts 固化入库）。 */
export const perfContractJson = () => ({
  schemaVersion: PERF_SCHEMA_VERSION,
  poseRanges: POSE_RANGES,
  frame: {
    m: { enum: [...VISEMES] },
    o: [0, 1], env: [0, 1], br: [-1, 1], nd: [-1, 1], gz: [-1, 1],
  },
  fps: [1, 240],
  intents: INTENTS,
  motion: {
    gazeTargetX: POSE_RANGES.gazeX, gazeTargetY: POSE_RANGES.gazeY,
    blinkAmp: [0, 1], blinkRate: [0, 10],
    headYawTiltNod: [-1, 1], breathBpm: [4, 40],
  },
  errorCodes: [
    'E_SCHEMA_VERSION', 'E_TYPE', 'E_RANGE', 'E_ENUM', 'E_MISSING', 'E_INCONSISTENT',
  ],
});
