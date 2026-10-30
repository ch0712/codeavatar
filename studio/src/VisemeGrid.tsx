import React from 'react';
import { AbsoluteFill } from 'remotion';
import { CHARS, FaceTraced, MOODS, NEUTRAL, VISEME } from '@anchor/core';
import type { CharKey, Pose, Viseme } from '@anchor/core';

const CW = 640;
const CH = 800;
const ORDER: Viseme[] = ['M', 'A', 'O', 'E', 'I', 'U'];

const applyViseme = (v: Viseme, p: Pose): Pose => ({ ...p, ...VISEME[v] });
const applyMood = (m: keyof typeof MOODS, p: Pose): Pose => ({ ...p, ...MOODS[m] });

export const VisemeGrid: React.FC<{ char?: CharKey }> = ({ char = 'no4' }) => (
  <AbsoluteFill style={{ background: '#141117' }}>
    {ORDER.map((v, i) => {
      let p: Pose = { ...NEUTRAL };
      p = applyMood('中性', p);
      p = applyViseme(v, p);
      return (
        <div
          key={v}
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
          >
            <FaceTraced pose={p} data={CHARS[char]} transparentBg />
          </div>
        </div>
      );
    })}
  </AbsoluteFill>
);
