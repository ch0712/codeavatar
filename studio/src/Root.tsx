import React from 'react';
import { CalculateMetadataFunction, Composition } from 'remotion';
import { Presenter, asPerf } from './Presenter';
import type { PresenterProps } from './Presenter';
import { VisemeGrid } from './VisemeGrid';
import { RuntimeGrid } from './RuntimeGrid';

const FPS = 30;

const calculateTalkClipMetadata: CalculateMetadataFunction<PresenterProps> = ({ props }) => {
  const perfData = props.perf ?? asPerf(props);
  const durationInFrames = perfData?.frames.length ?? 90;
  const fps = perfData?.fps ?? FPS;
  return {
    durationInFrames: Math.max(1, durationInFrames),
    fps: Number.isFinite(fps) && fps > 0 ? fps : FPS,
    width: 1920,
    height: 1080,
  };
};

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
        calculateMetadata={calculateTalkClipMetadata}
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
      {/* 零依赖运行时 parity：frames 由 tools/runtime_parity_check.py 通过 --props 注入 */}
      <Composition
        id="RuntimeGrid"
        component={RuntimeGrid}
        durationInFrames={1}
        fps={FPS}
        width={1920}
        height={1600}
        defaultProps={{ frames: [] as string[] }}
      />
    </>
  );
};
