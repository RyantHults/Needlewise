import {
  CellKind,
  DomainError,
  type BackstitchRecord,
  type BackstitchStore,
  type CreateDocumentOptions,
  type PaletteEntry,
  type PaletteEntryInput,
  type PaletteCatalogReference,
  type PaletteMaterial,
  type PatternSettings,
  type PatternDocument,
  type CatalogAssociation,
  type Point,
  type QuarterCorner,
  DEFAULT_PATTERN_SETTINGS,
  MaterialKind,
  MaterialUnit,
  DOCUMENT_SCHEMA_VERSION,
  PALETTE_ID_MAX,
  MAX_PERSISTABLE_CELL_COUNT
} from './types';
import { assertValidDocument } from './validation';

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

/** Symbol pool ceiling for a single printable symbol: 4 UTF-16 code units. */
export const MAX_PALETTE_SYMBOL_LENGTH = 4;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * True when the glyph is pure ASCII alphanumeric (letters or digits) or their
 * fullwidth forms — chart-noise that must not appear in the palette symbol
 * pool. All geometric, dingbat, box-drawing, math and emoji glyphs pass.
 */
export function isAlphanumericSymbol(glyph: string): boolean {
  if (glyph === '') return false;
  return [...glyph].every((unit) => {
    const code = unit.codePointAt(0) as number;
    return (
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0xff10 && code <= 0xff19) || // fullwidth 0-9
      (code >= 0xff21 && code <= 0xff3a) || // fullwidth A-Z
      (code >= 0xff41 && code <= 0xff5a) // fullwidth a-z
    );
  });
}

export function clonePaletteEntry(entry: PaletteEntry): PaletteEntry {
  return {
    id: entry.id,
    name: entry.name,
    color: entry.color,
    active: entry.active,
    symbol: entry.symbol,
    material: {
      kind: entry.material.kind,
      label: entry.material.label,
      unit: entry.material.unit,
      ...(entry.material.amount === undefined ? {} : { amount: entry.material.amount })
    },
    ...(entry.catalog === undefined
      ? {}
      : {
          catalog: {
            catalogId: entry.catalog.catalogId,
            sourceId: entry.catalog.sourceId,
            code: entry.catalog.code,
            name: entry.catalog.name,
            hex: entry.catalog.hex,
            rgb: [...entry.catalog.rgb] as [number, number, number]
          }
        })
  };
}

/**
 * Curated single-glyph chart symbols, ordered for neighbour distinction.
 * Tier 1 (first 128) carries the DMC 606 symbol-selector glyphs that render
 * well at cell size, interleaved by coarse visual class so neighbours stay
 * visually distinct. Tier 2 (next 72) extends the same interleave from the
 * remaining well-mannered candidates. The tail (index >= 200) keeps every
 * other glyph, including symbols that only read well at larger sizes.
 */
export const PALETTE_SYMBOLS: readonly string[] = [
   // Tier 1 — DMC 606 symbol-selector glyphs, class-interleaved.
   '\u25cf', // U+25CF BLACK CIRCLE
   '\u25b3', // U+25B3 WHITE UP-POINTING TRIANGLE
   '\u2715', // U+2715
   '\u25ed', // U+25ED UP-POINTING TRIANGLE WITH LEFT HALF BLACK
   '\u27f3', // U+27F3 CLOCKWISE GAPPED CIRCLE ARROW
   '\u21af', // U+21AF
   '\u2726', // U+2726
   '\u259b', // U+259B
   '\u25a1', // U+25A1 WHITE SQUARE
   '\u2720', // U+2720
   '\u2215', // U+2215
   '\u221e', // U+221E
   '\u2196', // U+2196
   '\u2739', // U+2739
   '\u25c6', // U+25C6 BLACK DIAMOND
   '\u2b1a', // U+2B1A
   '\u2225', // U+2225
   '\u25ff', // U+25FF LOWER RIGHT TRIANGLE
   '\u25d4', // U+25D4
   '\u2197', // U+2197
   '\u25ef', // U+25EF LARGE CIRCLE (replaces emoji-default U+1F4A7)
   '\u25b2', // U+25B2 BLACK UP-POINTING TRIANGLE
   '\u25a3', // U+25A3
   '\u220f', // U+220F
   '\u25f8', // U+25F8 UPPER LEFT TRIANGLE
   '\u223e', // U+223E INVERTED LAZY S
   '\u2199', // U+2199
   '\u2721', // U+2721 FIVE-POINTED STAR (pin removed; text-default)
   '\u25bc', // U+25BC BLACK DOWN-POINTING TRIANGLE
   '\u27d0', // U+27D0 WHITE DIAMOND WITH CENTRED DOT
   '\u2630', // U+2630
   '\u25fa', // U+25FA LOWER LEFT TRIANGLE
   '\u25c9', // U+25C9 FISHEYE
   '\u2198', // U+2198
   '\u275b', // U+275B HEAVY SINGLE TURNED COMMA QUOTATION MARK ORNAMENT
   '\u25b6', // U+25B6 BLACK RIGHT-POINTING TRIANGLE (pin removed; text-default)
   '\u27c1', // U+27C1 WHITE TRIANGLE CONTAINING SMALL WHITE TRIANGLE
   '\u21d5', // U+21D5 UP DOWN DOUBLE ARROW (replaces curated U+266F)
   '\u25f9', // U+25F9 UPPER RIGHT TRIANGLE
   '\u2299', // U+2299 CIRCLED DOT OPERATOR
   '\u2303', // U+2303
   '\u2745', // U+2745 TIGHT TRIFOLIATE SNOWFLAKE (replaces emoji-default U+26A1)
   '\u25c0', // U+25C0 BLACK LEFT-POINTING TRIANGLE (pin removed; text-default)
   '\u25a2', // U+25A2
   '\u2261', // U+2261 IDENTICAL TO
   '\u25f2', // U+25F2 WHITE SQUARE WITH LOWER RIGHT QUADRANT
   '\u2297', // U+2297 CIRCLED TIMES
   '\u2304', // U+2304
   '\u273d', // U+273D HEAVY TEARDROP-SPOKED PINWHEEL ASTERISK (replaces curated U+2655)
   '\u2580', // U+2580
   '\u25c8', // U+25C8
   '\u221a', // U+221A
   '\u2572', // U+2572 BOX DRAWINGS LIGHT DIAGONAL UPPER LEFT TO LOWER RIGHT
   '\u229b', // U+229B CIRCLED ASTERISK OPERATOR
   '\u2022', // U+2022 BULLET (replaces curated U+265F)
   '\u2584', // U+2584
   '\u25cb', // U+25CB WHITE CIRCLE
   '\u2310', // U+2310
   '\u25a9', // U+25A9
   '\u25ce', // U+25CE BULLSEYE
   '\u2058', // U+2058 FOUR DOT PUNCTUATION
   '\u258c', // U+258C
   '\u25fb', // U+25FB WHITE MEDIUM SQUARE
   '\u221f', // U+221F
   '\u2a2f', // U+2A2F VECTOR OR CROSS PRODUCT
   '\u25d0', // U+25D0 CIRCLE WITH LEFT HALF BLACK
   '\u28ff', // U+28FF BRAILLE PATTERN DOTS-12345678
   '\u2590', // U+2590
   '\u25e6', // U+25E6
   '\u25a6', // U+25A6 SQUARE WITH ORTHOGONAL CROSSHATCH FILL
   '\u2571', // U+2571 BOX DRAWINGS LIGHT DIAGONAL UPPER RIGHT TO LOWER LEFT
   '\u2316', // U+2316
   '\u2722', // U+2722
   '\u25a0', // U+25A0 BLACK SQUARE
   '\u2573', // U+2573 BOX DRAWINGS LIGHT DIAGONAL CROSS
   '\u2312', // U+2312
   '\u2601', // U+2601 CLOUD (pin removed; text-default)
   '\u2323', // U+2323
   '\u273f', // U+273F BLACK FLORETTE
   '\u222a', // U+222A
   '\u273e', // U+273E SIX PETALLED BLACK AND WHITE FLORETTE
   '\u2248', // U+2248 ALMOST EQUAL TO
   '\u2767', // U+2767 ROTATED FLORAL HEART BULLET
   '\u25e0', // U+25E0
   '\u2766', // U+2766 FLORAL HEART
   '\u25f4', // U+25F4 WHITE CIRCLE WITH UPPER LEFT QUADRANT
   '\u275c', // U+275C HEAVY SINGLE COMMA QUOTATION MARK ORNAMENT
   '\u229a', // U+229A CIRCLED RING OPERATOR
   '\u22c4', // U+22C4 DIAMOND OPERATOR (replaces curated U+2694)
   '\u29be', // U+29BE CIRCLED WHITE BULLSEYE
   '\u267b', // U+267B BLACK UNIVERSAL RECYCLING SYMBOL (replaces curated U+2691)
   '\u262f', // U+262F YIN YANG (pin removed; text-default)
   '\u00b6', // U+00B6 PILCROW SIGN
   '\u25e1', // U+25E1
   '\u2768', // U+2768 MEDIUM LEFT PARENTHESIS ORNAMENT
   '\u27f2', // U+27F2 ANTICLOCKWISE GAPPED CIRCLE ARROW
   '\u{1D11E}', // U+1D11E MUSICAL SYMBOL G CLEF
   '\u2295', // U+2295 CIRCLED PLUS
   '\u205c', // U+205C DOTTED CROSS
   '\u2665', // U+2665 BLACK HEART SUIT (replaces emoji-default U+26F3)
   '\u2660', // U+2660 BLACK SPADE SUIT (replaces emoji-default U+1F514)
   '\u273a', // U+273A
   '\u2619', // U+2619
   '\u00a7', // U+00A7 SECTION SIGN
   '\u2741', // U+2741 EIGHT PETALLED OUTLINED BLACK FLORETTE (replaces curated U+2698)
   '\u2734', // U+2734 EIGHT-POINTED PINWHEEL STAR (pin removed; text-default)
   '\u2618', // U+2618 SHAMROCK (pin removed; text-default)
   '\u2117', // U+2117 SOUND RECORDING COPYRIGHT (pin removed; text-default)
   '\u2668', // U+2668 HOT SPRINGS (replaces emoji-default U+1F6A9)
   '\u22a0', // U+22A0 SQUARED TIMES (replaces curated U+26B1)
   '\u266b', // U+266B BEAMED EIGHTH NOTES (replaces curated U+266A)
   '\u276a', // U+276A MEDIUM FLATTENED LEFT PARENTHESIS ORNAMENT
   '\u2692', // U+2692 HAMMER AND PICK (replaces emoji-default U+231A)
   '\u2699', // U+2699 GEAR (replaces curated U+2690)
   '\u2697', // U+2697 ALEMBIC (replaces curated U+2646)
   '\u2742', // U+2742 CIRCLED HEAVY WHITE RIGHTWARDS ARROW
   '\u283f', // U+283F BRAILLE PATTERN DOTS-123456
   '\u{1D13D}', // U+1D13D MUSICAL SYMBOL QUARTER REST
   '\u2733', // U+2733 EIGHT SPOKED ASTERISK (pin removed; text-default)
   '\u00bf', // U+00BF INVERTED QUESTION MARK
   '\u2727', // U+2727
   '\u2638', // U+2638 WHEEL OF DHARMA (pin removed; text-default)
   '\u269b', // U+269B ATOM SYMBOL (replaces emoji-default U+1F33E)
   '\u2740', // U+2740 WHITE FLORETTE
   '\u2550', // U+2550 BOX DRAWINGS DOUBLE HORIZONTAL (replaces emoji-default U+1F41A)
   '\u2774', // U+2774 MEDIUM LEFT CURLY BRACKET ORNAMENT
   '\u276c', // U+276C MEDIUM LEFT-POINTING ANGLE BRACKET ORNAMENT
   '\u216e', // U+216E ROMAN NUMERAL FIVE HUNDRED
   // Tier 2 — next 72 well-mannered candidates, class-interleaved.
   '\u2581', // U+2581
   '\u25c7', // U+25C7 WHITE DIAMOND
   '\u2500', // U+2500
   '\u2190', // U+2190
   '\u2605', // U+2605 BLACK STAR
   '\u2582', // U+2582
   '\u25bd', // U+25BD WHITE DOWN-POINTING TRIANGLE
   '\u2200', // U+2200
   '\u2b00', // U+2B00
   '\u271a', // U+271A HEAVY GREEK CROSS
   '\u2583', // U+2583
   '\u25d1', // U+25D1 CIRCLE WITH RIGHT HALF BLACK
   '\u2501', // U+2501
   '\u2191', // U+2191
   '\u2716', // U+2716 HEAVY MULTIPLICATION X (pin removed; text-default)
   '\u2585', // U+2585
   '\u25e2', // U+25E2 BLACK LOWER RIGHT TRIANGLE
   '\u2201', // U+2201
   '\u2b01', // U+2B01
   '\u2606', // U+2606 WHITE STAR
   '\u2586', // U+2586
   '\u25e3', // U+25E3 BLACK LOWER LEFT TRIANGLE
   '\u2502', // U+2502
   '\u2192', // U+2192
   '\u2700', // U+2700
   '\u2587', // U+2587
   '\u25e5', // U+25E5 BLACK UPPER RIGHT TRIANGLE
   '\u2202', // U+2202
   '\u2b02', // U+2B02
   '\u2600', // U+2600 BLACK SUN WITH RAYS (pin removed; text-default)
   '\u2588', // U+2588
   '\u25a4', // U+25A4 SQUARE WITH HORIZONTAL FILL
   '\u2503', // U+2503
   '\u2193', // U+2193
   '\u2300', // U+2300
   '\u2589', // U+2589
   '\u25a5', // U+25A5 SQUARE WITH VERTICAL FILL
   '\u2203', // U+2203
   '\u2b03', // U+2B03
   '\u2701', // U+2701
   '\u258a', // U+258A
   '\u25a7', // U+25A7
   '\u2504', // U+2504
   '\u2194', // U+2194
   '\u2301', // U+2301
   '\u258b', // U+258B
   '\u25a8', // U+25A8
   '\u2204', // U+2204
   '\u2b04', // U+2B04
   '\u25f0', // U+25F0 WHITE SQUARE WITH UPPER LEFT QUADRANT (replaces curated U+2702)
   '\u258d', // U+258D
   '\u25aa', // U+25AA
   '\u2505', // U+2505
   '\u2195', // U+2195
   '\u2602', // U+2602 UMBRELLA (pin removed; text-default)
   '\u258e', // U+258E
   '\u25ab', // U+25AB
   '\u2205', // U+2205
   '\u2b05', // U+2B05 LEFTWARDS BLACK ARROW (pin removed; text-default)
   '\u2302', // U+2302
   '\u258f', // U+258F
   '\u25ac', // U+25AC
   '\u2506', // U+2506
   '\u2b06', // U+2B06 UPWARDS BLACK ARROW (pin removed; text-default)
   '\u2703', // U+2703
   '\u2591', // U+2591
   '\u25ad', // U+25AD
   '\u2206', // U+2206
   '\u2b07', // U+2B07 DOWNWARDS BLACK ARROW (pin removed; text-default)
   '\u2603', // U+2603 SNOWMAN (pin removed; text-default)
   '\u2592', // U+2592
   '\u25ae', // U+25AE
   // Tail — remaining pool; not auto-assigned by the first two tiers.
   '\u2704', // U+2704
   '\u25f1', // U+25F1 WHITE SQUARE WITH LOWER LEFT QUADRANT (replaces curated U+2604)
   '\u25f5', // U+25F5 WHITE CIRCLE WITH UPPER RIGHT QUADRANT (replaces emoji-default U+2705)
   '\u25f6', // U+25F6 WHITE CIRCLE WITH LOWER LEFT QUADRANT (replaces curated U+2607)
   '\u2305', // U+2305
   '\u2706', // U+2706
   '\u25f7', // U+25F7 WHITE CIRCLE WITH LOWER RIGHT QUADRANT (replaces curated U+2608)
   '\u2306', // U+2306
   '\u2507', // U+2507
   '\u2707', // U+2707
   '\u25f3', // U+25F3 WHITE SQUARE WITH LOWER RIGHT QUADRANT (replaces curated U+2609)
   '\u2307', // U+2307
   '\u2207', // U+2207
   '\u2508', // U+2508
   '\u21c7', // U+21C7 LEFTWARDS PAIRED ARROWS (replaces curated U+2708)
   '\u21c8', // U+21C8 UPWARDS PAIRED ARROWS (replaces curated U+260A)
   '\u2b08', // U+2B08
   '\u2308', // U+2308
   '\u2208', // U+2208
   '\u2509', // U+2509
   '\u21c9', // U+21C9 RIGHTWARDS PAIRED ARROWS (replaces curated U+2709)
   '\u21ca', // U+21CA DOWNWARDS PAIRED ARROWS (replaces curated U+260B)
   '\u2b09', // U+2B09
   '\u2309', // U+2309
   '\u2209', // U+2209
   '\u250a', // U+250A
   '\u25af', // U+25AF
   '\u21cc', // U+21CC RIGHTWARDS HARPOON OVER LEFTWARDS HARPOON (replaces curated U+270E)
   '\u219a', // U+219A
   '\u21cd', // U+21CD LEFTWARDS DOUBLE ARROW WITH STROKE (replaces curated U+260C)
   '\u2b0a', // U+2B0A
   '\u230a', // U+230A
   '\u220a', // U+220A
   '\u250b', // U+250B
   '\u25b0', // U+25B0
   '\u21cf', // U+21CF RIGHTWARDS DOUBLE ARROW WITH STROKE (replaces curated U+270F)
   '\u219b', // U+219B
   '\u21ce', // U+21CE LEFTWARDS RIGHTWARDS DOUBLE ARROW WITH STROKE (replaces curated U+260D)
   '\u2b0b', // U+2B0B
   '\u230b', // U+230B
   '\u220b', // U+220B
   '\u250c', // U+250C
   '\u25b1', // U+25B1
   '\u2710', // U+2710
   '\u219c', // U+219C
   '\u21d0', // U+21D0 LEFTWARDS DOUBLE ARROW (replaces curated U+260E)
   '\u2b0c', // U+2B0C
   '\u230c', // U+230C
   '\u220c', // U+220C
   '\u250d', // U+250D
   '\u25b4', // U+25B4
   '\u2711', // U+2711
   '\u219d', // U+219D
   '\u260f', // U+260F
   '\u2b0d', // U+2B0D
   '\u230d', // U+230D
   '\u220d', // U+220D
   '\u250e', // U+250E
   '\u25b5', // U+25B5
   '\u2712', // U+2712 BLACK NIB (pin removed; text-default)
   '\u219e', // U+219E
   '\u2610', // U+2610
   '\u2b0e', // U+2B0E
   '\u230e', // U+230E
   '\u220e', // U+220E
   '\u250f', // U+250F
   '\u25b7', // U+25B7
   '\u2713', // U+2713
   '\u219f', // U+219F
   '\u2611', // U+2611 BALLOT BOX WITH CHECK (pin removed; text-default)
   '\u2b0f', // U+2B0F
   '\u230f', // U+230F
   '\u2510', // U+2510
   '\u25b8', // U+25B8
   '\u2714', // U+2714 HEAVY CHECK MARK (pin removed; text-default)
   '\u21a0', // U+21A0
   '\u2612', // U+2612
   '\u2b10', // U+2B10
   '\u2210', // U+2210
   '\u2511', // U+2511
   '\u25b9', // U+25B9
   '\u21a1', // U+21A1
   '\u2613', // U+2613
   '\u2b11', // U+2B11
   '\u2311', // U+2311
   '\u2211', // U+2211
   '\u2512', // U+2512
   '\u25ba', // U+25BA
   '\u2717', // U+2717
   '\u21a2', // U+21A2
   '\u21d2', // U+21D2 RIGHTWARDS DOUBLE ARROW (replaces emoji-default U+2614)
   '\u2b12', // U+2B12
   '\u2212', // U+2212
   '\u2513', // U+2513
   '\u2593', // U+2593
   '\u25bb', // U+25BB
   '\u2718', // U+2718
   '\u21a3', // U+21A3
   '\u21d4', // U+21D4 LEFT RIGHT DOUBLE ARROW (replaces emoji-default U+2615)
   '\u2b13', // U+2B13
   '\u2313', // U+2313
   '\u2213', // U+2213
   '\u2514', // U+2514
   '\u2594', // U+2594
   '\u25be', // U+25BE
   '\u2719', // U+2719
   '\u21a4', // U+21A4
   '\u2616', // U+2616
   '\u2b14', // U+2B14
   '\u2314', // U+2314
   '\u2214', // U+2214
   '\u2515', // U+2515
   '\u2595', // U+2595
   '\u25bf', // U+25BF
   '\u271b', // U+271B
   '\u21a5', // U+21A5
   '\u2617', // U+2617
   '\u2b15', // U+2B15
   '\u2315', // U+2315
   '\u2516', // U+2516
   '\u2596', // U+2596
   '\u25c1', // U+25C1
   '\u271c', // U+271C
   '\u21a6', // U+21A6
   '\u2b16', // U+2B16
   '\u2216', // U+2216
   '\u2517', // U+2517
   '\u2597', // U+2597
   '\u25c2', // U+25C2
   '\u271d', // U+271D LATIN CROSS (pin removed; text-default)
   '\u21a7', // U+21A7
   '\u2b17', // U+2B17
   '\u2317', // U+2317
   '\u2217', // U+2217
   '\u2518', // U+2518
   '\u2598', // U+2598
   '\u25c3', // U+25C3
   '\u271e', // U+271E
   '\u21a8', // U+21A8
   '\u261a', // U+261A
   '\u2b18', // U+2B18
   '\u2318', // U+2318
   '\u2218', // U+2218
   '\u2519', // U+2519
   '\u2599', // U+2599
   '\u25c4', // U+25C4
   '\u271f', // U+271F
   '\u21a9', // U+21A9
   '\u261b', // U+261B
   '\u2b19', // U+2B19
   '\u2319', // U+2319
   '\u2219', // U+2219
   '\u251a', // U+251A
   '\u259a', // U+259A
   '\u25c5', // U+25C5
   '\u21aa', // U+21AA
   '\u261c', // U+261C
   '\u251b', // U+251B
   '\u21ab', // U+21AB
   '\u261e', // U+261E
   '\u25fc', // U+25FC BLACK MEDIUM SMALL SQUARE (replaces emoji-default U+2B1B)
   '\u21d6', // U+21D6 NORTH WEST DOUBLE ARROW (replaces emoji-default U+231B)
   '\u221b', // U+221B
   '\u251c', // U+251C
   '\u259c', // U+259C
   '\u25ca', // U+25CA
   '\u21ac', // U+21AC
   '\u261f', // U+261F
   '\u21d7', // U+21D7 NORTH EAST DOUBLE ARROW (replaces emoji-default U+2B1C)
   '\u231c', // U+231C
   '\u221c', // U+221C
   '\u251d', // U+251D
   '\u259d', // U+259D
   '\u25cc', // U+25CC
   '\u2723', // U+2723
   '\u21ad', // U+21AD
   '\u2620', // U+2620 SKULL AND CROSSBONES (pin removed; text-default)
   '\u2b1d', // U+2B1D
   '\u231d', // U+231D
   '\u221d', // U+221D
   '\u251e', // U+251E
   '\u259e', // U+259E
   '\u25cd', // U+25CD
   '\u2724', // U+2724
   '\u21ae', // U+21AE
   '\u2621', // U+2621
   '\u2b1e', // U+2B1E
   '\u231e', // U+231E
   '\u251f', // U+251F
   '\u259f', // U+259F
   '\u25d2', // U+25D2
   '\u2725', // U+2725
   '\u2622', // U+2622 RADIOACTIVE SIGN (pin removed; text-default)
   '\u2b1f', // U+2B1F
   '\u231f', // U+231F
   '\u2520', // U+2520
   '\u25d3', // U+25D3
   '\u21b0', // U+21B0
   '\u2623', // U+2623 BIOHAZARD SIGN (pin removed; text-default)
   '\u2b20', // U+2B20
   '\u2320', // U+2320
   '\u2220', // U+2220
   '\u2521', // U+2521
   '\u21b1', // U+21B1
   '\u2624', // U+2624
   '\u2b21', // U+2B21
   '\u2321', // U+2321
   '\u2221', // U+2221
   '\u2522', // U+2522
   '\u25d5', // U+25D5
   '\u21d9', // U+21D9 SOUTH WEST DOUBLE ARROW (replaces emoji-default U+2728)
   '\u21b2', // U+21B2
   '\u2625', // U+2625
   '\u2b22', // U+2B22
   '\u2322', // U+2322
   '\u2222', // U+2222
   '\u2523', // U+2523
   '\u25d6', // U+25D6
   '\u2729', // U+2729
   '\u21b3', // U+21B3
   '\u2626', // U+2626 ORTHODOX CROSS (pin removed; text-default)
   '\u2b23', // U+2B23
   '\u2223', // U+2223
   '\u2524', // U+2524
   '\u25d7', // U+25D7
   '\u272a', // U+272A
   '\u21b4', // U+21B4
   '\u2627', // U+2627
   '\u2b24', // U+2B24
   '\u2324', // U+2324
   '\u2224', // U+2224
   '\u2525', // U+2525
   '\u25d8', // U+25D8
   '\u272b', // U+272B
   '\u21b5', // U+21B5
   '\u2628', // U+2628
   '\u2b25', // U+2B25
   '\u2325', // U+2325
   '\u2526', // U+2526
   '\u25d9', // U+25D9
   '\u272c', // U+272C
   '\u21b6', // U+21B6
   '\u2629', // U+2629
   '\u2b26', // U+2B26
   '\u2326', // U+2326
   '\u2226', // U+2226
   '\u2527', // U+2527
   '\u25da', // U+25DA
   '\u272d', // U+272D
   '\u21b7', // U+21B7
   '\u262a', // U+262A STAR AND CRESCENT (pin removed; text-default)
   '\u2b27', // U+2B27
   '\u2327', // U+2327
   '\u2227', // U+2227
   '\u2528', // U+2528
   '\u25db', // U+25DB
   '\u272e', // U+272E
   '\u21b8', // U+21B8
   '\u262b', // U+262B
   '\u2b28', // U+2B28
   '\u2329', // U+2329
   '\u2228', // U+2228
   '\u2529', // U+2529
   '\u25dc', // U+25DC
   '\u272f', // U+272F
   '\u21b9', // U+21B9
   '\u262c', // U+262C
   '\u2b29', // U+2B29
   '\u232a', // U+232A
   '\u2229', // U+2229
   '\u252a', // U+252A
   '\u25dd', // U+25DD
   '\u2730', // U+2730
   '\u21ba', // U+21BA
   '\u262d', // U+262D
   '\u2b2a', // U+2B2A
   '\u232b', // U+232B
   '\u252b', // U+252B
   '\u25de', // U+25DE
   '\u2731', // U+2731
   '\u21bb', // U+21BB
   '\u262e', // U+262E PEACE SYMBOL (pin removed; text-default)
   '\u2b2b', // U+2B2B
   '\u232c', // U+232C
   '\u222b', // U+222B
   '\u252c', // U+252C
   '\u25df', // U+25DF
   '\u2732', // U+2732
   '\u21bc', // U+21BC
   '\u2b2c', // U+2B2C
   '\u232d', // U+232D
   '\u222c', // U+222C
   '\u252d', // U+252D
   '\u21bd', // U+21BD
   '\u2b2d', // U+2B2D
   '\u232e', // U+232E
   '\u222d', // U+222D
   '\u252e', // U+252E
   '\u21be', // U+21BE
   '\u2631', // U+2631
   '\u2b2e', // U+2B2E
   '\u232f', // U+232F
   '\u222e', // U+222E
   '\u252f', // U+252F
   '\u25e4', // U+25E4
   '\u2735', // U+2735
   '\u21bf', // U+21BF
   '\u2632', // U+2632
   '\u2b2f', // U+2B2F
   '\u2330', // U+2330
   '\u222f', // U+222F
   '\u2530', // U+2530
   '\u2736', // U+2736
   '\u21c0', // U+21C0
   '\u2633', // U+2633
   '\u2b30', // U+2B30
   '\u2331', // U+2331
   '\u2230', // U+2230
   '\u2531', // U+2531
   '\u25e7', // U+25E7
   '\u2737', // U+2737
   '\u21c1', // U+21C1
   '\u2634', // U+2634
   '\u2b31', // U+2B31
   '\u2332', // U+2332
   '\u2231', // U+2231
   '\u2532', // U+2532
   '\u25e8', // U+25E8
   '\u2738', // U+2738
   '\u21c2', // U+21C2
   '\u2635', // U+2635
   '\u2b32', // U+2B32
   '\u2333', // U+2333
   '\u2232', // U+2232
   '\u2533', // U+2533
   '\u25e9', // U+25E9
   '\u21c3', // U+21C3
   '\u2636', // U+2636
   '\u2b33', // U+2B33
   '\u2334', // U+2334
   '\u2233', // U+2233
   '\u2534', // U+2534
   '\u25ea', // U+25EA
   '\u21c4', // U+21C4
   '\u2637', // U+2637
   '\u2b34', // U+2B34
   '\u2335', // U+2335
   '\u2234', // U+2234
   '\u2535', // U+2535
   '\u25eb', // U+25EB
   '\u273b', // U+273B
   '\u21c5', // U+21C5
   '\u2b35', // U+2B35
   '\u2336', // U+2336
   '\u2235', // U+2235
   '\u2536', // U+2536
   '\u25ec', // U+25EC
   '\u273c', // U+273C
   '\u21c6', // U+21C6
   '\u263c', // U+263C
   '\u2b36', // U+2B36
];

export function defaultPaletteSymbol(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new DomainError('invalid-palette-id', `Palette ID ${String(id)} is invalid.`);
  // Palette IDs start at 1. The symbol pool is larger than the usual catalog
  // palette ceiling, so every valid palette ID maps to a unique
  // glyph. Past the end of the list the assignment cycles deterministically as
  // a safety tail (id > PALETTE_SYMBOLS.length reuses the id-1 glyph); that
  // tail is unreachable for palettes within the business ceiling.
  return PALETTE_SYMBOLS[(id - 1) % PALETTE_SYMBOLS.length];
}

/**
 * True when this entry's symbol is the cycled default for its own id AND
 * that cycled default is already taken by a sibling — i.e. the entry was
 * produced by the auto-assign overflow path and so is exempt from the
 * validator's duplicate-symbol guard. Explicit symbol assignment and
 * palette-update reassignment keep the guard, so only true auto-overflow
 * entries are flagged here. With the symbol pool larger than the brand
 * palette ceiling this path is unreachable for valid palettes (harmless).
 */
export function isAutoOverflowEntry(entry: PaletteEntry, palette: readonly PaletteEntry[]): boolean {
  if (entry.symbol !== defaultPaletteSymbol(entry.id)) return false;
  for (const other of palette) {
    if (other.id !== entry.id && other.symbol === entry.symbol) return true;
  }
  return false;
}

export function defaultPaletteMaterial(name: string, catalog?: PaletteCatalogReference): PaletteMaterial {
  return {
    kind: catalog === undefined ? MaterialKind.Custom : MaterialKind.Floss,
    label: catalog?.name ?? name,
    unit: MaterialUnit.Skeins
  };
}

export function clonePatternSettings(settings: PatternSettings): PatternSettings {
  return { symbolSet: settings.symbolSet, materialUnit: settings.materialUnit };
}

export function normalizePatternSettings(settings: Partial<PatternSettings> | undefined): PatternSettings {
  const symbolSet = settings?.symbolSet ?? DEFAULT_PATTERN_SETTINGS.symbolSet;
  const materialUnit = settings?.materialUnit ?? DEFAULT_PATTERN_SETTINGS.materialUnit;
  if (typeof symbolSet !== 'string' || symbolSet.trim() === '') throw new DomainError('invalid-settings', 'The symbol set must be a non-empty string.');
  if (![MaterialUnit.Skeins, MaterialUnit.Meters, MaterialUnit.Count].includes(materialUnit)) throw new DomainError('invalid-settings', `Material unit ${String(materialUnit)} is invalid.`);
  return { symbolSet, materialUnit };
}

function normalizeCatalogReference(value: unknown): PaletteCatalogReference | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw new DomainError('invalid-catalog-reference', 'Catalog references must be objects.');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.catalogId !== 'string' || !candidate.catalogId.trim() || typeof candidate.sourceId !== 'string' || !candidate.sourceId.trim() || typeof candidate.code !== 'string' || !candidate.code.trim() || typeof candidate.name !== 'string' || !candidate.name.trim() || typeof candidate.hex !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(candidate.hex) || !Array.isArray(candidate.rgb) || candidate.rgb.length !== 3 || candidate.rgb.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) throw new DomainError('invalid-catalog-reference', 'Catalog references have invalid identity or color data.');
  const rgb = candidate.rgb as number[];
  const expected = [Number.parseInt(candidate.hex.slice(1, 3), 16), Number.parseInt(candidate.hex.slice(3, 5), 16), Number.parseInt(candidate.hex.slice(5, 7), 16)];
  if (rgb.some((channel, index) => channel !== expected[index])) throw new DomainError('invalid-catalog-reference', 'Catalog HEX and RGB values must agree.');
  return { catalogId: candidate.catalogId, sourceId: candidate.sourceId, code: candidate.code, name: candidate.name, hex: candidate.hex.toUpperCase(), rgb: [...rgb] as [number, number, number] };
}

export function paletteLimit(document: Pick<PatternDocument, 'catalog'>): number {
  return Math.min(document.catalog.colorCount, PALETTE_ID_MAX);
}

function normalizeMaterial(value: unknown, fallbackName: string, catalog?: PaletteCatalogReference): PaletteMaterial {
  if (value === undefined) return defaultPaletteMaterial(fallbackName, catalog);
  if (typeof value !== 'object' || value === null) throw new DomainError('invalid-material', 'Palette materials must be objects.');
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;
  const label = candidate.label;
  const unit = candidate.unit;
  if (kind !== MaterialKind.Floss && kind !== MaterialKind.Custom) throw new DomainError('invalid-material', 'Palette material kind is invalid.');
  if (typeof label !== 'string' || !label.trim()) throw new DomainError('invalid-material', 'Palette material labels must not be empty.');
  if (unit !== MaterialUnit.Skeins && unit !== MaterialUnit.Meters && unit !== MaterialUnit.Count) throw new DomainError('invalid-material', 'Palette material unit is invalid.');
  const amount = candidate.amount;
  if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) throw new DomainError('invalid-material', 'Palette material amount must be a non-negative finite number.');
  return { kind, label, unit, ...(amount === undefined ? {} : { amount }) };
}

export function normalizePaletteEntry(input: PaletteEntryInput | PaletteEntry, idOverride?: number): PaletteEntry {
  if (!isObject(input)) throw new DomainError('invalid-palette', 'Palette entries must be objects.');
  const entryId = idOverride ?? input.id;
  if (typeof entryId !== 'number' || !Number.isInteger(entryId) || entryId < 1 || entryId > PALETTE_ID_MAX) throw new DomainError('invalid-palette-id', `Palette ID ${String(entryId)} is invalid.`);
  const id: number = entryId;
  if (typeof input.name !== 'string' || input.name.trim() === '') throw new DomainError('invalid-palette', 'Palette names must not be empty.');
  if (typeof input.color !== 'string' || input.color.trim() === '') throw new DomainError('invalid-palette', 'Palette colors must not be empty.');
  const catalog = normalizeCatalogReference(input.catalog);
  const symbol = input.symbol ?? defaultPaletteSymbol(id);
  if (typeof symbol !== 'string' || symbol.trim() === '') throw new DomainError('invalid-palette-symbol', 'Palette symbols must not be empty.');
  if (symbol.length > MAX_PALETTE_SYMBOL_LENGTH) throw new DomainError('invalid-palette-symbol', `Palette symbols must be at most ${String(MAX_PALETTE_SYMBOL_LENGTH)} UTF-16 code units.`);
  if (isAlphanumericSymbol(symbol)) throw new DomainError('invalid-palette-symbol', 'Palette symbols must be non-alphanumeric Unicode (no ASCII letters, digits, or fullwidth forms).');
  const material = normalizeMaterial(input.material, input.name, catalog);
  return { id, name: input.name, color: input.color, active: input.active !== false, symbol, material, ...(catalog === undefined ? {} : { catalog }) };
}

export function emptyBackstitches(): BackstitchStore {
  return {
    ids: new Uint32Array(0),
    x1: new Uint32Array(0),
    y1: new Uint32Array(0),
    x2: new Uint32Array(0),
    y2: new Uint32Array(0),
    colors: new Uint16Array(0),
    completed: new Uint8Array(0)
  };
}

function normalizePalette(
  entries: Array<PaletteEntryInput | PaletteEntry> | undefined,
  catalog: CatalogAssociation
): { palette: PaletteEntry[]; nextPaletteId: number } {
  const palette: PaletteEntry[] = [];
  const ids = new Set<number>();
  let nextId = 1;
  const limit = Math.min(catalog.colorCount, PALETTE_ID_MAX);

  for (const input of entries ?? []) {
    const id = input.id === undefined ? nextId : input.id;
    if (typeof id === 'number' && id > limit) {
      throw new DomainError('invalid-palette-id', `The palette cannot exceed the brand's color count (${String(limit)}).`);
    }
    if (!Number.isInteger(id) || id < 1 || id > limit || ids.has(id)) {
      throw new DomainError('invalid-palette-id', `Palette ID ${String(id)} is invalid or duplicated.`);
    }
    const entry = normalizePaletteEntry(input, id);
    if (entry.catalog !== undefined && entry.catalog.catalogId !== catalog.catalogId) {
      throw new DomainError('invalid-catalog-reference', `Palette ID ${String(entry.id)} belongs to a different catalog.`);
    }
    if (palette.some((candidate) => candidate.symbol === entry.symbol)) throw new DomainError('invalid-palette-symbol', `Palette symbol ${entry.symbol} is duplicated.`);
    ids.add(id);
    palette.push(entry);
    nextId = Math.max(nextId, id + 1);
  }

  if (nextId > PALETTE_ID_MAX) {
    nextId = PALETTE_ID_MAX + 1;
  }
  return { palette, nextPaletteId: nextId };
}

export function createDocument(options: CreateDocumentOptions): PatternDocument;
export function createDocument(options: CreateDocumentOptions): PatternDocument {
  if (
    !Number.isInteger(options.width) ||
    !Number.isInteger(options.height) ||
    options.width < 1 ||
    options.height < 1
  ) {
    throw new DomainError('invalid-dimensions', 'Pattern dimensions must be positive integers.');
  }
  const cellCount = options.width * options.height;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_PERSISTABLE_CELL_COUNT) {
    throw new DomainError('invalid-dimensions', 'Pattern dimensions are too large.');
  }

  if (typeof options.catalog !== 'object' || options.catalog === null) {
    throw new DomainError('invalid-catalog', 'A catalog association is required.');
  }
  const catalog = {
    catalogId: options.catalog.catalogId,
    brandLabel: options.catalog.brandLabel,
    colorCount: options.catalog.colorCount
  };
  const { palette, nextPaletteId } = normalizePalette(options.palette, catalog);
  const document: PatternDocument = {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog,
    width: options.width,
    height: options.height,
    kind: new Uint8Array(cellCount),
    colors: new Uint16Array(cellCount * 4),
    completed: new Uint8Array(cellCount),
    backstitches: emptyBackstitches(),
    palette,
    settings: normalizePatternSettings(options.settings),
    revision: 0,
    nextBackstitchId: 1,
    nextPaletteId
  };
  assertValidDocument(document);
  return document;
}

export const createPatternDocument = createDocument;
export const createPattern = createDocument;

export function cloneDocument(document: PatternDocument): PatternDocument {
  return {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog: {
      catalogId: document.catalog.catalogId,
      brandLabel: document.catalog.brandLabel,
      colorCount: document.catalog.colorCount
    },
    width: document.width,
    height: document.height,
    kind: document.kind.slice(),
    colors: document.colors.slice(),
    completed: document.completed.slice(),
    backstitches: {
      ids: document.backstitches.ids.slice(),
      x1: document.backstitches.x1.slice(),
      y1: document.backstitches.y1.slice(),
      x2: document.backstitches.x2.slice(),
      y2: document.backstitches.y2.slice(),
      colors: document.backstitches.colors.slice(),
      completed: document.backstitches.completed.slice()
    },
    palette: document.palette.map(clonePaletteEntry),
    settings: clonePatternSettings(document.settings),
    revision: document.revision,
    nextBackstitchId: document.nextBackstitchId,
    nextPaletteId: document.nextPaletteId
  };
}

export function cellIndex(document: PatternDocument, x: number, y: number): number {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= document.width ||
    y >= document.height
  ) {
    throw new DomainError('out-of-bounds', `Cell (${String(x)}, ${String(y)}) is out of bounds.`);
  }
  return y * document.width + x;
}

export function colorsOffset(index: number): number {
  return index * 4;
}

export function findPaletteEntry(document: PatternDocument, id: number): PaletteEntry | undefined {
  return document.palette.find((entry) => entry.id === id);
}

export function requirePaletteEntry(document: PatternDocument, id: number): PaletteEntry {
  if (!Number.isInteger(id) || id < 1 || id > PALETTE_ID_MAX) {
    throw new DomainError('invalid-palette-id', `Palette ID ${String(id)} is invalid.`);
  }
  const entry = findPaletteEntry(document, id);
  if (!entry) {
    throw new DomainError('unknown-palette', `Palette ID ${String(id)} does not exist.`);
  }
  if (!entry.active) {
    throw new DomainError('inactive-palette', `Palette ID ${String(id)} is inactive.`);
  }
  return entry;
}

export function readBackstitch(
  document: PatternDocument,
  index: number
): BackstitchRecord {
  const store = document.backstitches;
  return {
    id: store.ids[index],
    x1: store.x1[index],
    y1: store.y1[index],
    x2: store.x2[index],
    y2: store.y2[index],
    start: { x: store.x1[index], y: store.y1[index] },
    end: { x: store.x2[index], y: store.y2[index] },
    color: store.colors[index],
    completed: store.completed[index] === 1
  };
}

export function listBackstitches(document: PatternDocument): BackstitchRecord[] {
  return Array.from(document.backstitches.ids, (_, index) => readBackstitch(document, index));
}

export function backstitchCount(document: PatternDocument): number {
  return document.backstitches.ids.length;
}

export function getBackstitch(
  document: PatternDocument,
  id: number
): BackstitchRecord | undefined {
  const index = document.backstitches.ids.findIndex((candidate) => candidate === id);
  return index < 0 ? undefined : readBackstitch(document, index);
}

export function point(x: number, y: number): Point {
  return { x, y };
}

export { UINT16_MAX, UINT32_MAX };

export function getCell(document: PatternDocument, x: number, y: number) {
  const index = cellIndex(document, x, y);
  const offset = colorsOffset(index);
  const kind = document.kind[index];
  const completion = document.completed[index];
  const threeQuarterCorners = isThreeQuarterKind(kind) || isThreeQuarterPairKind(kind) ? threeQuarterCornersForCell(document, index) : [];
  const primaryThreeQuarterCorner = threeQuarterCorners[0];
  const color = isThreeQuarterPairKind(kind) && primaryThreeQuarterCorner !== undefined
    ? document.colors[offset + primaryThreeQuarterCorner]
    : document.colors[offset];
  const completed = isThreeQuarterPairKind(kind) && primaryThreeQuarterCorner !== undefined
    ? (completion & (1 << primaryThreeQuarterCorner)) !== 0
    : (completion & 1) !== 0;
  return {
    x,
    y,
    kind,
    color,
    completed,
    completionMask: completion,
    quarters: [
      { color: kind === CellKind.Quarters ? document.colors[offset] : 0, completed: kind === CellKind.Quarters && (completion & 1) !== 0 },
      { color: kind === CellKind.Quarters ? document.colors[offset + 1] : 0, completed: kind === CellKind.Quarters && (completion & 2) !== 0 },
      { color: kind === CellKind.Quarters ? document.colors[offset + 2] : 0, completed: kind === CellKind.Quarters && (completion & 4) !== 0 },
      { color: kind === CellKind.Quarters ? document.colors[offset + 3] : 0, completed: kind === CellKind.Quarters && (completion & 8) !== 0 }
    ] as const,
    threeQuarters: [0, 1, 2, 3].map((corner) => getThreeQuarterAtIndex(document, index, corner as QuarterCorner)) as readonly { color: number; completed: boolean }[]
  };
}

export const getCellState = getCell;

export function getQuarter(document: PatternDocument, x: number, y: number, corner: number) {
  if (!Number.isInteger(corner) || corner < 0 || corner > 3) {
    throw new DomainError('invalid-corner', `Quarter corner ${String(corner)} is invalid.`);
  }
  const index = cellIndex(document, x, y);
  const offset = colorsOffset(index) + corner;
  return {
    color: document.kind[index] === CellKind.Quarters ? document.colors[offset] : 0,
    completed: document.kind[index] === CellKind.Quarters && (document.completed[index] & (1 << corner)) !== 0
  };
}

export function isQuarterKind(kind: number): boolean {
  return kind === CellKind.Quarters;
}

export function isThreeQuarterSingleKind(kind: number): boolean {
  return kind === CellKind.ThreeQuarterNW
    || kind === CellKind.ThreeQuarterNE
    || kind === CellKind.ThreeQuarterSE
    || kind === CellKind.ThreeQuarterSW;
}

export function isThreeQuarterPairKind(kind: number): boolean {
  return kind === CellKind.ThreeQuarterPair;
}

export function isThreeQuarterKind(kind: number): boolean {
  return isThreeQuarterSingleKind(kind);
}

export function threeQuarterKindForCorner(corner: QuarterCorner): CellKind {
  if (!Number.isInteger(corner) || corner < 0 || corner > 3) throw new DomainError('invalid-corner', `Three-quarter corner ${String(corner)} is invalid.`);
  return [CellKind.ThreeQuarterNW, CellKind.ThreeQuarterNE, CellKind.ThreeQuarterSE, CellKind.ThreeQuarterSW][corner] as CellKind;
}

export function threeQuarterCornerForKind(kind: number): QuarterCorner | undefined {
  if (kind === CellKind.ThreeQuarterNW) return 0;
  if (kind === CellKind.ThreeQuarterNE) return 1;
  if (kind === CellKind.ThreeQuarterSE) return 2;
  if (kind === CellKind.ThreeQuarterSW) return 3;
  return undefined;
}

export function oppositeQuarterCorner(corner: QuarterCorner): QuarterCorner {
  if (!Number.isInteger(corner) || corner < 0 || corner > 3) throw new DomainError('invalid-corner', `Quarter corner ${String(corner)} is invalid.`);
  return ((corner + 2) % 4) as QuarterCorner;
}

function getThreeQuarterAtIndex(document: PatternDocument, index: number, corner: QuarterCorner): { color: number; completed: boolean } {
  const kind = document.kind[index];
  const offset = colorsOffset(index);
  const singleCorner = threeQuarterCornerForKind(kind);
  if (singleCorner === corner) return { color: document.colors[offset], completed: (document.completed[index] & 1) !== 0 };
  if (isThreeQuarterPairKind(kind)) return { color: document.colors[offset + corner], completed: (document.completed[index] & (1 << corner)) !== 0 };
  return { color: 0, completed: false };
}

function threeQuarterCornersForCell(document: PatternDocument, index: number): QuarterCorner[] {
  const kind = document.kind[index];
  const singleCorner = threeQuarterCornerForKind(kind);
  if (singleCorner !== undefined) return document.colors[index * 4] === 0 ? [] : [singleCorner];
  if (!isThreeQuarterPairKind(kind)) return [];
  const offset = index * 4;
  return [0, 1, 2, 3].filter((corner) => document.colors[offset + corner] !== 0) as QuarterCorner[];
}

export function threeQuarterCornersForCellAt(document: PatternDocument, index: number): readonly QuarterCorner[] {
  if (!Number.isInteger(index) || index < 0 || index >= document.kind.length) return [];
  return threeQuarterCornersForCell(document, index);
}

export function getThreeQuarter(document: PatternDocument, x: number, y: number, corner: number): { color: number; completed: boolean } {
  if (!Number.isInteger(corner) || corner < 0 || corner > 3) throw new DomainError('invalid-corner', `Three-quarter corner ${String(corner)} is invalid.`);
  return getThreeQuarterAtIndex(document, cellIndex(document, x, y), corner as QuarterCorner);
}

export const getThreeQuarterComponent = getThreeQuarter;
