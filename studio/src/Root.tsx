import React from 'react';
import { Composition } from 'remotion';
import { Presenter } from './Presenter';
import { VisemeGrid } from './VisemeGrid';

const FPS = 30;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* 口播成片：char + perf + 可选字幕/底图 */}
      <Composition
        id="TalkClip"
        component={Presenter}
        durationInFrames={90}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{
          char: 'no4' as const,
          layout: 'full' as const,
          bg: '#141117',
        }}
      />
      <Composition
        id="CharStill"
        component={Presenter}
        durationInFrames={1}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ char: 'no4' as const, layout: 'full' as const }}
      />
      {/* 六格口型表：机检 gate_mouth.py 的输入 */}
      <Composition
        id="VisemeGrid"
        component={VisemeGrid}
        durationInFrames={1}
        fps={FPS}
        width={1920}
        height={1600}
        defaultProps={{ char: 'no4' as const }}
      />
    </>
  );
};
