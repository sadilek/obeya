// Obeya's sign, three cards spread over the canvas in the colours of working, waiting and approved, and
// its wordmark, "obeya" in Inter Bold as outlines. `bun scripts/logo.tsx` writes them as the files in
// src/ui/logo/ (favicon, PNGs, the README's wordmark).

// on a 32-unit square
const CARDS = [
  { x: 2, y: 3, w: 17, h: 8, fill: '#3b82f6' },
  { x: 11, y: 12.5, w: 19, h: 8, fill: '#f59e0b' },
  { x: 4, y: 22, w: 14, h: 7, fill: '#16a34a' },
];
// Inter Bold at 2048 units per em, scaled to an x-height of 16 units on the baseline at 24, each
// letter at its x
const GLYPH_SCALE = 0.01431;
const LETTERS: [number, string][] = [
  [39.00, 'M628 22Q460 22 337.0 -50.5Q214 -123 147.5 -252.5Q81 -382 81 -554Q81 -727 147.5 -857.0Q214 -987 337.0 -1059.5Q460 -1132 628 -1132Q796 -1132 919.0 -1059.5Q1042 -987 1108.5 -857.0Q1175 -727 1175 -554Q1175 -382 1108.5 -252.5Q1042 -123 919.0 -50.5Q796 22 628 22ZM628 -214Q748 -214 809.0 -311.0Q870 -408 870 -555Q870 -703 809.0 -799.5Q748 -896 628 -896Q508 -896 447.5 -799.5Q387 -703 387 -555Q387 -408 447.5 -311.0Q508 -214 628 -214Z'],
  [56.62, 'M754 19Q663 19 600.0 -12.0Q537 -43 497.5 -88.5Q458 -134 437 -179H423V0H128V-1490H428V-930H437Q457 -974 495.5 -1021.0Q534 -1068 597.5 -1100.0Q661 -1132 756 -1132Q880 -1132 983.0 -1068.0Q1086 -1004 1147.5 -876.0Q1209 -748 1209 -557Q1209 -371 1149.0 -242.5Q1089 -114 986.0 -47.5Q883 19 754 19ZM662 -222Q779 -222 840.5 -316.0Q902 -410 902 -558Q902 -705 841.0 -798.5Q780 -892 662 -892Q546 -892 483.5 -801.0Q421 -710 421 -558Q421 -406 484.0 -314.0Q547 -222 662 -222Z'],
  [74.75, 'M633 22Q462 22 338.0 -48.0Q214 -118 147.5 -247.0Q81 -376 81 -553Q81 -726 147.5 -856.0Q214 -986 334.5 -1059.0Q455 -1132 618 -1132Q764 -1132 883.0 -1070.0Q1002 -1008 1072.5 -882.0Q1143 -756 1143 -565V-481H378Q383 -344 454.0 -274.0Q525 -204 638 -204Q717 -204 773.5 -237.5Q830 -271 854 -336L1126 -285Q1085 -146 956.5 -62.0Q828 22 633 22ZM380 -669H854Q843 -778 784.0 -842.0Q725 -906 621 -906Q513 -906 451.0 -839.5Q389 -773 380 -669Z'],
  [91.86, 'M120 396 189 170 226 179Q317 204 375.0 175.5Q433 147 443 63L451 3L31 -1118H350L538 -538Q561 -465 577.0 -392.5Q593 -320 609 -246Q627 -321 646.5 -393.5Q666 -466 690 -538L886 -1118H1201L726 132Q675 267 579.5 346.5Q484 426 316 426Q256 426 204.0 417.5Q152 409 120 396Z'],
  [109.15, 'M440 22Q280 22 174.0 -62.5Q68 -147 68 -313Q68 -438 128.0 -509.0Q188 -580 284.0 -613.0Q380 -646 490 -656Q634 -670 697.5 -685.5Q761 -701 761 -756V-761Q761 -832 715.5 -871.0Q670 -910 586 -910Q499 -910 446.0 -872.5Q393 -835 375 -781L100 -827Q143 -972 271.5 -1052.0Q400 -1132 587 -1132Q707 -1132 815.5 -1094.0Q924 -1056 992.5 -972.5Q1061 -889 1061 -753V0H777V-155H767Q726 -77 645.0 -27.5Q564 22 440 22ZM525 -189Q630 -189 696.5 -250.0Q763 -311 763 -400V-521Q745 -508 704.5 -498.5Q664 -489 619.0 -481.5Q574 -474 541 -470Q458 -458 407.0 -423.0Q356 -388 356 -321Q356 -256 403.5 -222.5Q451 -189 525 -189Z'],
];
const WORD_W = 125.81;

const Cards = () => (
  <>
    {CARDS.map((c) => (
      <rect key={c.y} x={c.x} y={c.y} width={c.w} height={c.h} rx={2.2} fill={c.fill} />
    ))}
  </>
);

export function Sign({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <Cards />
    </svg>
  );
}

/** The sign with "obeya" beside it; `ink` colours the letters (the text colour by default). */
export function Wordmark({ height = 32, ink = 'currentColor' }: { height?: number; ink?: string }) {
  return (
    <svg height={height} width={+((WORD_W * height) / 32).toFixed(1)} viewBox={`0 0 ${WORD_W} 32`} xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Obeya">
      <Cards />
      {LETTERS.map(([x, d]) => (
        <path key={x} transform={`translate(${x} 24) scale(${GLYPH_SCALE})`} d={d} fill={ink} />
      ))}
    </svg>
  );
}
