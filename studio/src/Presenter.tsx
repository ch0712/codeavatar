import React from 'react';
import { AbsoluteFill } from 'remotion';
import { CHARS, FaceTraced, NEUTRAL } from '@anchor/core';
import type { CharKey, Perf, Caption, Pose } from '@anchor/core';
import { poseAt, moodLabels } from '@anchor/core';

/** 角色画布坐标系（所有角色数据都按 1360x2048 描摹）。 */
export const CANVAS_W = 1360;
export const CANVAS_H = 2048;

export type PresenterProps = {
  char: CharKey;
  /** 表演数据：逐帧 viseme / mood / 强度。没有就渲染静止中性脸。 */
  perf?: Perf;
  /** 构图：full = 角色占满画面（竖屏口播）；pip = 右下圆形画中画。 */
  layout?: 'full' | 'pip';
  bg?: string;
  captions?: Caption[];
  captionStyle?: React.CSSProperties;
  /** 角色在画面里的纵向锚点（0.5 = 头居中；越小越靠上）。 */
  anchorY?: number;
};

const PipClip: React.FC<{ children: React.ReactNode; size: number }> = ({ children, size }) => (
  <div
    style={{
      position: 'absolute',
      right: size * 0.08,
      bottom: size * 0.10,
      width: size,
      height: size,
      borderRadius: '50%',
      overflow: 'hidden',
      boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
    }}
  >
    {children}
  </div>
);

export const Presenter: React.FC<PresenterProps> = ({
  char,
  perf,
  layout = 'full',
  bg = '#141117',
  captions,
  captionStyle,
  anchorY = 0.42,
}) => {
  const frame = useCurrentFrameSafe();
  const fps = useVideoConfigSafe();
  const labels = perf ? moodLabels(perf) : [];
  const pose: Pose = perf ? poseAt(frame, fps, perf, labels) : { ...NEUTRAL };
  const data = CHARS[char];

  const head = <FaceTraced pose={pose} data={data} transparentBg />;

  if (layout === 'pip') {
    const size = 320;
    const scale = size / CANVAS_W;
    return (
      <AbsoluteFill style={{ background: bg }}>
        <PipClip size={size}>
          <div
            style={{
              width: CANVAS_W,
              height: CANVAS_H,
              transform: `scale(${scale})`,
              transformOrigin: '50% 18%',
            }}
          >
            {head}
          </div>
        </PipClip>
      </AbsoluteFill>
    );
  }

  const scale = 1;
  return (
    <AbsoluteFill style={{ background: bg }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: `${anchorY * 100}%`,
          width: CANVAS_W * scale,
          height: CANVAS_H * scale,
          transform: `translate(-50%, -18%)`,
        }}
      >
        {head}
      </div>
      {captions && captions.length > 0 ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: '8%',
            display: 'flex',
            justifyContent: 'center',
            padding: '0 8%',
          }}
        >
          <div
            style={{
              color: '#F7F2E8',
              fontSize: 56,
              lineHeight: 1.35,
              fontWeight: 600,
              textAlign: 'center',
              letterSpacing: 1,
              textShadow: '0 2px 12px rgba(0,0,0,0.55)',
              ...captionStyle,
            }}
          >
            {activeText(captions, frame, fps)}
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const activeText = (caps: Caption[], frame: number, fps: number): string => {
  const t = frame / fps;
  const hit = caps.find((c) => t >= c.t0 && t < c.t1);
  return hit ? hit.text : '';
};

// 这两个 hook 只在组件内部用，抽出来只是为了让 Presenter 在非 Remotion 环境（测试）下也能 import
import { useCurrentFrame, useVideoConfig } from 'remotion';
const useCurrentFrameSafe = () => useCurrentFrame();
const useVideoConfigSafe = () => useVideoConfig().fps;
