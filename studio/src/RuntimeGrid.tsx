import React from 'react';
import { AbsoluteFill } from 'remotion';

/**
 * 只用于「零依赖运行时」的 parity 校验，不参与成片输出。
 *
 * 与 VisemeGrid.tsx 的布局逐像素一致，唯一区别：
 *   VisemeGrid   → React 直接渲染 <FaceTraced/>
 *   RuntimeGrid  → 注入构建期由 renderFaceSvg() SSR 出来的 SVG 字符串
 *
 * 两张图都经 `remotion still` 输出，页面环境 / Chrome 启动参数 / 截图管线
 * 完全相同，因此任何像素差异都只能归因于 SVG 本身 —— 这才是
 * 「同一个渲染器脱离 Remotion 后视觉零漂移」的有效断言。
 */
export type RuntimeGridProps = { frames: string[] };

const CW = 640;
const CH = 800;

export const RuntimeGrid: React.FC<RuntimeGridProps> = ({ frames }) => (
  <AbsoluteFill style={{ background: '#141117' }}>
    {frames.slice(0, 6).map((svg, i) => (
      <div
        key={i}
        style={{
          position: 'absolute',
          left: (i % 3) * CW,
          top: Math.floor(i / 3) * CH,
          width: CW,
          height: CH,
          overflow: 'hidden',
          borderRight: '1px solid #2A2630',
          borderBottom: '1px solid #2A2630',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: CW / 2 - (1360 * 0.52) / 2,
            top: -190,
            width: 1360 * 0.52,
            height: 2048 * 0.52,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    ))}
  </AbsoluteFill>
);
