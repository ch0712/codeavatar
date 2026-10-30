// src/anchor-code/FaceTraced.tsx
import React from 'react';
import { Pose } from './types';
import no1 from './chars/no1.json';
import no4 from './chars/no4.json';
import no5 from './chars/no5.json';
import no6 from './chars/no6.json';

/**
 * 由设定稿「描」出来的主播脸 —— 几何来自设计稿本身（tools/trace_design.py）。
 *
 * v2（本轮改造，2026-10-27）：
 *   上一版把「唇面色块」围绕唇上沿做 scaleY，实测 A 口型只比闭嘴高 1.25 倍
 *   （参数上应该是 2.81 倍）—— 因为它缩的是唇色那一小片，不是"嘴"这个结构。
 *   本版按 gpt-6 给的最小集重做：
 *     ① 嘴 = 一个变换组（唇上/唇下/口腔/牙 各自独立，不再整体缩放）
 *     ② 下颌通道：唇中线以下的整片区域随张口下沉（接缝藏在唇部）
 *     ③ 口腔暗部由开口量驱动，夹在上下唇之间
 *     ④ 上唇固定、下唇下移 → 消除"厚嘴唇"
 *     ⑤ 牙按开口区间显隐，闭嘴不穿帮
 *   全部仍是数值驱动，无贴图切换。
 */

export type CharLayer = {
  id: string;
  hex: string;
  d: string;
  box: [number, number, number, number];
  area: number;
  role?: string | null;
  side?: string | number | null;
  eye?: number;
};

export type CharData = {
  canvas: [number, number];
  bg: string;
  skin: string;
  skinBox: [number, number, number, number];
  lipBox: [number, number, number, number] | null;
  lipColor?: string | null;
  eyes: { cx: number; cy: number; w: number; h: number }[];
  brows: { side?: string; box: [number, number, number, number]; hex: string }[];
  layers: CharLayer[];
  key?: string;
};

export const CHARS: Record<'no1' | 'no4' | 'no5' | 'no6', CharData> = {
  no1: no1 as unknown as CharData,
  no4: no4 as unknown as CharData,
  no5: no5 as unknown as CharData,
  no6: no6 as unknown as CharData,
};
export type CharKey = keyof typeof CHARS;

/** 由角色 skin 色推导鼻部四色。
 *
 * 2026-10-30：原来是四个写死的十六进制（#FBC087 / #D8965F / #DFA670 / #5A3520），
 * 那是按 NO.4 的肤色 #F0B781 量的。换到 NO.5（#E8C29D，更暗更冷）时鼻子整块发白、
 * 变成贴上去的一块 —— 补件的比例本来就是相对唇框的，颜色也必须相对肤色。
 * 系数是在 NO.4 上反解出来的，代回去与原来的四个常量相差 ≤ 6/通道。
 */
const scaleHex = (hex: string, k: [number, number, number]): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const c = (v: number, kk: number) => Math.max(0, Math.min(255, Math.round(v * kk)));
  return `#${[c(r, k[0]), c(g, k[1]), c(b, k[2])]
    .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
    .join('')}`;
};

const lum = (h: string) =>
  0.299 * parseInt(h.slice(1, 3), 16) + 0.587 * parseInt(h.slice(3, 5), 16) + 0.114 * parseInt(h.slice(5, 7), 16);

export const FaceTraced: React.FC<{ pose: Pose; data: CharData; transparentBg?: boolean }> = ({
  pose,
  data,
  transparentBg,
}) => {
  const p = pose;
  const [W, H] = data.canvas;
  const LAYERS = data.layers;
  const EYES = data.eyes ?? [];
  const LIP = LAYERS.find((l) => l.role === 'mouth') ?? null;
  // ⚠ 2026-10-28：role 判定把「上唇 c35（浅棕）」标成了 mouthline，而
  // LAYERS.find(role==='mouthline') 先命中的正是它 → 真正的深色唇线 c5 从来没被画出来，
  // 上唇又被当成「唇线」只画在上半区，于是成片像「两层嘴巴」。
  // 改为按亮度区分：深色的是唇线，浅色的是上唇（角色无关，换角自动适配）。
  const _ml = LAYERS.filter((l) => l.role === 'mouthline');
  const LIP_LINE = _ml.find((l) => parseInt(l.hex.slice(1, 3), 16) < 110) ?? null;
  const UPPER_LIP = _ml.find((l) => l !== LIP_LINE) ?? null;
  const MOUTH_LINE = UPPER_LIP;

  const lid = Math.max(0.05, p.lid * (1 - p.blink));
  const BROW_UNIT = (data.skinBox[2] - data.skinBox[0]) * 0.028;
  // 视线幅度按脸宽定（2026-10-28）：以前是写死 7px/5px，在 1360 画布上只有成片 4px，
  // 等于看不出在动。按 faceW×0.015 ≈ 11.5 设定稿px（成片约 6.5px，眼宽 56px 的 12%），
  // 再夹到 ±1.15，避免瞳孔被推出眼线弧。
  // 幅度上限由「瞳孔贴到眼线外端之前」定：实测设定稿瞳孔 rx≈22（眼宽 116），
  // 允许位移 ≈ 9 设定稿px（成片约 5px，眼宽的 8%）；再多瞳孔就顶到眼线外端、糊成一团。
  const gazeX = Math.max(-1, Math.min(1, p.gazeX)) * (data.skinBox[2] - data.skinBox[0]) * 0.012;
  const gazeY = Math.max(-1, Math.min(1, p.gazeY)) * (data.skinBox[2] - data.skinBox[0]) * 0.006;

  // ── 嘴部几何基准 ──
  const lipTop = LIP ? LIP.box[1] : 0;
  const lipBot = LIP ? LIP.box[3] : 0;
  const lipCx = LIP ? (LIP.box[0] + LIP.box[2]) / 2 : 0;
  const lipW = LIP ? LIP.box[2] - LIP.box[0] : 0;
  const lipH = LIP ? Math.max(4, lipBot - lipTop) : 0;
  const lipMid = (lipTop + lipBot) / 2;

  const faceW = data.skinBox[2] - data.skinBox[0];
  const faceH = data.skinBox[3] - data.skinBox[1];

  // 开口量：mouthOpen 是主控，wide/round 只改横向与圆度，不再参与纵向
  const open = Math.max(0, Math.min(1.15, p.mouthOpen));
  const jawDrop = open * faceH * 0.028 + Math.max(0, p.jaw) * faceH * 0.012;
  const lipDrop = open * lipH * 1.15 + jawDrop * 0.55;
  // 横向展开系数 0.20 → 0.28 → 0.45（2026-10-28 成片门槛实测 M/I 只差 14.3%，差一点点不达标）。
  // 原因：情绪（smile）也会给闭嘴加宽（轻松 smile=0.85 → +2.6%），把人「衣」的展开优势吃掉了；
  // 且唇面是描摹多边形，横向 scale 的实测增益只有名义值的约 0.6 倍（量化误差），
  // 所以 0.28 名义只换来实测 16.7%。提到 0.45 后「衣」才真正成为最宽的口型（衣=横向咧嘴）。
  const wideK = 1 + p.mouthWide * 0.45 - p.mouthRound * 0.2 + p.smile * (open > 0.1 ? 0.1 : 0.03);

  // 口腔：夹在上下唇之间的空隙里
  // ⚠️ 2026-10-28 修 bug：rx 原来写成 lipW*0.42*wideK，而这段又在 scale(wideK 1) 的组里，
  //    → 横向被平方放大（wideK 1.45 时 rx 达 0.88*lipW），「衣」的口腔溢出唇形、
  //    在脸上拖出一条比嘴唇更宽的暗线（8 倍放大实测溢出约 5px）。wideK 交给外层组做一次就够。
  //    去掉多余的 wideK 后，rx 与唇宽恒为 0.84 的比例，任何口型都不会溢出。
  //    （试过用 clipPath 裁口腔：SVG 1.1 规定 clipPath 子元素的 transform 被忽略 →
  //      6 份位移副本全叠在一起，A 的口腔被切掉下半截、露出肤色，机检 A/M 掉到 0.83x。已放弃该方案。）
  // 口腔 = **上唇下缘与下移后的红唇之间那条缝**（不是唇框中心）。
  // 红唇整块下移后，若口腔还画在唇框中心，就会被红唇压住 → 口型开合量测不出来
  // （实测 幅度 1.12x、闭唇 69%，闸门直接 FAIL）。
  // 口腔不再用椭圆参数：2026-10-30 改为「同一个 LIP.d 三层叠加」（见渲染段）。
  // 旧参数（cavCy/cavRx=0.34·lipW/cavRy）已删除——独立椭圆与唇形是两条无关曲线，
  // 无论怎么调比例，两端都会和唇脱开。这是结构问题，不是参数问题。
  const teethAlpha = open < 0.16 ? 0 : open < 0.34 ? (open - 0.16) / 0.18 : 1;

  const headT = `translate(0 ${p.nod * 8 + p.jaw * 2.4}) rotate(${p.tilt * 3.2} ${W / 2} ${H * 0.42})`;

  const chinX0 = data.skinBox[0] - faceW * 0.35;
  const chinX1 = data.skinBox[2] + faceW * 0.35;
  const chinY1 = data.skinBox[3] + faceH * 0.28;
  // 下颌重画只允许「脸皮」参与：皮肤大层的 bbox 底 == 下巴底。
  // 之前把「肤色系」全放进来，颈部阴影（bbox 底 1384 > 下巴底 1209）跟着下移，
  // 领口/颈影被整体拽下去 → 成片里领口下方一条横向硬缝（2026-10-28 老板第二次看片指出）。
  const CHIN_BOTTOM = data.skinBox[3];

  const isMouthLayer = (l: CharLayer) => l.role === 'mouth' || l.role === 'mouthline';

  /* ── 鼻子（2026-10-30 第二次重构） ──
     老板指出成片里「上下两个鼻孔」：旧版按 no4 反解补了 4 件独立几何——
     鼻尖亮三角（skin×1.05）、鼻底阴影椭圆（skin×0.9/0.85/0.75）、两条鼻翼弧、
     两个 skin×[0.38,0.41,0.25] 的实心椭圆「鼻孔」（实测 #585027，Δ vs 肤色 144/114/118）。
     问题不是参数没调好，是**设定稿里根本没有鼻孔**（NO.4 只有一道极淡的鼻梁影），
     我们凭空造了两个最暗的件，于是鼻子的读法只剩「两颗痣」。

     扁平卡通脸上，鼻子的正确表达是**一层比皮肤暗 ~8~12% 的柔面 + 两条极短鼻翼弧**，
     不画孔、不画亮三角。对比度全部由 skin 推导，换角色自动跟随。
     闸门 gate_mouth 的 G6 就是量这一条：鼻子区不许出现 Δlum>40 的暗块。 */
  const NOSE = {
    cx: lipCx,
    cy: lipTop - faceH * 0.152,
    rx: faceW * 0.042,
    ry: faceH * 0.026,
    shadowHex: scaleHex(data.skin, [0.93, 0.9, 0.875]),
    arcHex: scaleHex(data.skin, [0.905, 0.885, 0.865]),
    arcTopY: lipTop - faceH * 0.196,
    arcBotY: lipTop - faceH * 0.130,
    arcTopDx: faceW * 0.052,
    arcBotDx: faceW * 0.068,
    arcStroke: Math.max(2, faceW * 0.0042),
  };

  /** 除嘴以外的层（会被画两遍：唇中线以上固定，以下随下颌下沉） */
  const renderBody = (l: CharLayer) => {
    const role = l.role;
    if (l.hex === data.bg) return null;
    // ── 量化噪点（2026-10-30）──────────────────────────────────────────
    // 老板看到的「两个鼻孔」不是我们补的件，是 **no5 数据层里的两块冷色碎块**：
    //   c2_373D44 [702,847,725,856] 153px / c3_373D44 [639,847,661,856] 151px
    // 设定稿那里是鼻子下方的柔和渐变，K=14 量化把它切成了两块硬边冷灰（B≥R），
    // 位置正好在鼻翼下方左右对称、23×9 px —— 摆在脸上就是两个鼻孔。
    // 判据：脸皮范围内 + 面积 < 500px + 冷色（B≥R）+ 无明确角色 → 判为量化噪点丢弃。
    // no1 / no4 实测 0 块（这条规则对它们是空操作），所以不会改动既有两个角色。
    {
      const r = parseInt(l.hex.slice(1, 3), 16);
      const b = parseInt(l.hex.slice(5, 7), 16);
      const sb = data.skinBox;
      const inFace = l.box[0] >= sb[0] && l.box[2] <= sb[2] && l.box[1] >= sb[1] && l.box[3] <= sb[3];
      if (!role && l.area < 500 && b >= r && inFace) return null;
    }
    {
      const boxArea = (l.box[2] - l.box[0]) * (l.box[3] - l.box[1]);
      const thin = boxArea > 0 && boxArea / Math.max(1, l.area) > 8;
      if (thin && lum(l.hex) > 175 && role !== 'eye') return null;
    }
    if (role === 'brow' || role === 'brow_fill') {
      const s = l.side === 'L' ? -1 : l.side === 'R' ? 1 : 0;
      const lift = -p.brow * BROW_UNIT - p.browIn * BROW_UNIT * 0.45 + p.browAsym * BROW_UNIT * 0.6 * s;
      return <path key={`${l.id}-b`} d={l.d} fill={l.hex} transform={`translate(0 ${lift})`} />;
    }
    // eye/lid = 眼线弧（只吃眨眼与眼睑缩放）；iris = 瞳孔（额外吃视线位移）
    if (role === 'eye' || role === 'lid' || role === 'iris') {
      // 用该层自身包围盒中心做缩放中心：NO.4 两眼 bbox 不对称，用全局眼位会把瞳孔移歪
      const ex = (l.box[0] + l.box[2]) / 2;
      const ey = (l.box[1] + l.box[3]) / 2;
      const g = role === 'iris' ? `translate(${gazeX} ${gazeY})` : '';
      return (
        <path
          key={`${l.id}-e`}
          d={l.d}
          fill={l.hex}
          transform={`translate(${ex} ${ey}) scale(1 ${lid}) translate(${-ex} ${-ey}) ${g}`}
        />
      );
    }
    // 描摹时眼线被瞳孔挡掉的那段在数据里是「补出来的」：路径含外轮廓 + 内洞，
    // 必须 evenodd 填充，否则洞会被填实、瞳孔（画在下层）被盖住。
    return (
      <path
        key={`${l.id}-s`}
        d={l.d}
        fillRule={(l as CharLayer & { fillRule?: 'evenodd' }).fillRule}
        fill={l.hex}
        stroke={role === 'seam' ? 'none' : l.hex}
        strokeWidth={
          role === 'seam'
            ? 0
            : role === 'lid' || role === 'iris'
              ? 0             // 眼线/瞳孔互为补集（lid = M − iris），本身无缝；描边反而会在瞳孔顶边压出缺口
              // 大块（脸/颈影/衣料，面积 > 2 万 px）给 2.5px 自分色描边：它们与相邻大块的
              // 边界在曲线化后会有 0.5~1px 缝，0.6px 盖不住 → 成片里下巴/领口出现发丝dark线+虚线点。
              // 薄片（镜框/眉/眼线，几百~几千 px）仍是 0.6px，避免被描边撑胖。
              : l.area > 20000 ? 2.5 : 0.6
        }
        strokeLinejoin="round"
      />
    );
  };

  const bodyLayers = LAYERS.filter((l) => !isMouthLayer(l));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" style={{ display: 'block' }}>
      <defs>
        {/* 唇中线以上 / 以下：同一批层画两遍，下半随下颌下沉，接缝藏在唇部 */}
        <clipPath id="fc-upper">
          <rect x={0} y={0} width={W} height={Math.max(0, lipMid)} />
        </clipPath>
        <clipPath id="fc-chin">
          <rect
            x={chinX0}
            y={lipMid}
            width={Math.max(1, chinX1 - chinX0)}
            height={Math.max(1, chinY1 - lipMid)}
          />
        </clipPath>
        {/* 唇上 / 唇下 */}
        <clipPath id="fc-lip-up">
          <rect
            x={LIP ? LIP.box[0] - lipW : 0}
            y={0}
            width={W}
            height={Math.max(0, lipMid + 2)}
          />
        </clipPath>
        <clipPath id="fc-lip-dn">
          <rect
            x={LIP ? LIP.box[0] - lipW : 0}
            y={Math.max(0, lipMid - 2)}
            width={W}
            height={Math.max(1, H - lipMid + 2)}
          />
        </clipPath>
      </defs>

      {!transparentBg && <rect x={0} y={0} width={W} height={H} fill={data.bg} />}

      <g transform={headT}>
        {/* 全身/脸：只画一遍。上一版把下半脸裁出来画第二遍 → 中间漏缝成黑线、肩膀被裁掉 */}
        {bodyLayers.map(renderBody)}

        {/* 鼻子：设定稿里描摹丢失的那一层，按唇框比例补回**一层柔影**（无鼻孔、无高光件）。
            静态几何，不参与表情/下颌。 */}
        <g id="nose">
          <ellipse cx={NOSE.cx} cy={NOSE.cy} rx={NOSE.rx} ry={NOSE.ry} fill={NOSE.shadowHex} opacity={0.9} />
          {/* 鼻翼两条短弧：上窄下张，只到鼻尖两侧，不闭合、不画孔 */}
          {[-1, 1].map((s) => (
            <path
              key={`nose-arc-${s}`}
              d={`M ${lipCx + s * NOSE.arcTopDx} ${NOSE.arcTopY} C ${lipCx + s * NOSE.arcTopDx * 1.02} ${
                NOSE.arcTopY + (NOSE.arcBotY - NOSE.arcTopY) * 0.55
              } ${lipCx + s * NOSE.arcBotDx * 0.98} ${NOSE.arcBotY - (NOSE.arcBotY - NOSE.arcTopY) * 0.28} ${
                lipCx + s * NOSE.arcBotDx
              } ${NOSE.arcBotY}`}
              fill="none"
              stroke={NOSE.arcHex}
              strokeWidth={NOSE.arcStroke}
              strokeLinecap="round"
              opacity={0.9}
            />
          ))}
        </g>

        {/* 下颌不再「裁剪后平移肤色层」重画：那样必然在裁切边缘（嘴高度）切断脸轮廓 →
            2× 放大就是两道台阶（老板 2026-10-28 指出「脸颊向外断层」）。
            下巴起伏改由 headT 里的 p.jaw 整体带动 + 下唇 lipDrop 表达。 */}
        {/* ── 嘴：上唇 + 唇线固定；红唇**整块**下移（不再按 lipMid 切成上下两半 → 不会有「两层嘴」） ── */}
        {(LIP || UPPER_LIP || LIP_LINE) && (
          <g transform={`translate(${lipCx} ${lipTop}) scale(${wideK} 1) translate(${-lipCx} ${-lipTop})`}>
            {/* 上唇（浅棕） */}
            {UPPER_LIP && (
              <path d={UPPER_LIP.d} fill={UPPER_LIP.hex} stroke={UPPER_LIP.hex} strokeWidth={0.8} strokeLinejoin="round" />
            )}
            {/* 深色唇线：闭口时可见，张口时随开合淡出 */}
            {LIP_LINE && (
              <path
                d={LIP_LINE.d}
                fill={LIP_LINE.hex}
                opacity={Math.max(0, 1 - Math.min(1, open * 2.2))}
              />
            )}
            {/* 口腔 + 牙：**用同一块唇形连画三层**，不再用独立椭圆。
                旧版口腔是 ellipse(rx=0.34·lipW)，红唇是另一块 path 整块下移 —— 两条无关曲线
                只在中间相切，左右两端必然裂开，成片就是「嘴巴和嘴唇脱离两层」。
                现在用同一个 LIP.d 画三遍：
                  ① 填白（牙）
                  ② 下移 0.42·lipDrop 填深棕（口腔）→ 顶部露出的那一条天然就是牙
                  ③ 下移 lipDrop 填唇色（红唇）
                任何开合量下口腔都严格是唇形的一部分，几何上不可能与唇脱开，
                两端也会随着唇的收窄自然收口。 */}
            {open > 0.12 && LIP && (
              <g>
                {teethAlpha > 0 && (
                  // 牙：同一块唇形，但**横向收到 0.68、纵向压扁到 0.55**（锚点在唇顶）。
                  // 不压扁时白带的形状就是唇峰那条 M 形起伏，成片读起来像"上唇涂了白色/白胡子"。
                  // 压扁后唇峰的起伏减半，白带变薄，读作「上排牙」。
                  <path
                    d={LIP.d}
                    fill="#E9E1D3"
                    opacity={teethAlpha * 0.95}
                    transform={`translate(${lipCx} ${lipTop}) scale(0.68 0.62) translate(${-lipCx} ${-lipTop})`}
                  />
                )}
                <path d={LIP.d} fill="#42201C" transform={`translate(0 ${0.42 * lipDrop})`} />
                <path
                  d={LIP.d}
                  fill="#8E4038"
                  opacity={p.mouthRound > 0.5 && open > 0.34 ? 0.85 : 0}
                  transform={`translate(0 ${0.66 * lipDrop})`}
                />
              </g>
            )}
            {/* 红唇：整块平移 lipDrop（不加 clip，切一半就会露缝 = 「两层嘴」） */}
            {LIP && (
              // 下移 + 纵向拉伸：真实下唇在张口时会被拉长，只平移会让「口型可分性」归零（实测 1.01x/23.8%→FAIL）
              <g
                transform={`translate(0 ${lipDrop}) translate(${lipCx} ${lipMid}) scale(1 ${1 + Math.min(1, open) * 0.30}) translate(${-lipCx} ${-lipMid})`}
              >
                <path d={LIP.d} fill={LIP.hex} stroke={LIP.hex} strokeWidth={1.2} strokeLinejoin="round" />
              </g>
            )}
          </g>
        )}
      </g>
    </svg>
  );
};
