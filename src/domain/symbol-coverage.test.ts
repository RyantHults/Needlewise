import { expect, it } from 'vitest';
import {
  isAlphanumericSymbol,
  MAX_PALETTE_SYMBOL_LENGTH,
  PALETTE_SYMBOLS
} from './index';

/**
 * Golden coverage set for the 128 hand-curated DMC 606 symbol-selector
 * descriptions (symbols.md). One plausible Unicode glyph per description,
 * listed in description order 1..128. Every glyph here must be usable as a
 * palette symbol (non-alphanumeric, <= 4 UTF-16 units) and present in the pool.
 * The pool is emoji-free: goldens map every emoji-default description to a
 * text-presentation-default replacement (no U+FE0E anywhere), enforced below.
 */
const DESCRIPTION_SYMBOLS: readonly string[] = [
  '✦', // 1
  '⟳', // 2
  '✹', // 3
  '◯', // 4
  '✕', // 5
  '✡', // 6
  '△', // 7
  '❛', // 8
  '□', // 9
  '❅', // 10
  '✠', // 11
  '✽', // 12
  '∞', // 13
  '◔', // 14
  '∾', // 15
  '◉', // 16
  '•', // 17
  '⁘', // 18
  '⣿', // 19
  '⬚', // 20
  '✢', // 21
  '☁', // 22
  '✿', // 23
  '✾', // 24
  '❧', // 25
  '◭', // 26
  '❦', // 27
  '❜', // 28
  '⊙', // 29
  '⋄', // 30
  '♻', // 31
  '¶', // 32
  '∕', // 33
  '◿', // 34
  '◸', // 35
  '◺', // 36
  '◹', // 37
  '◲', // 38
  '∥', // 39
  '⊗', // 40
  '❨', // 41
  '𝄞', // 42
  '▛', // 43
  '⁜', // 44
  '▣', // 45
  '♥', // 46
  '∏', // 47
  '⊛', // 48
  '◎', // 49
  '⟐', // 50
  '♠', // 51
  '↯', // 52
  '✺', // 53
  '☙', // 54
  '╲', // 55
  '§', // 56
  '❁', // 57
  '✴', // 58
  '◐', // 59
  '⌖', // 60
  '⟁', // 61
  '☘', // 62
  '℗', // 63
  '♨', // 64
  '⊠', // 65
  '⌒', // 66
  '♫', // 67
  '❪', // 68
  '▢', // 69
  '⚒', // 70
  '☰', // 71
  '⇕', // 72
  '▩', // 73
  '⚙', // 74
  '⚗', // 75
  '≡', // 76
  '√', // 77
  '⌣', // 78
  '❂', // 79
  '∪', // 80
  '⨯', // 81
  '⠿', // 82
  '≈', // 83
  '◠', // 84
  '◴', // 85
  '𝄽', // 86
  '✳', // 87
  '◆', // 88
  '◈', // 89
  '⊚', // 90
  '⦾', // 91
  '○', // 92
  '●', // 93
  '╱', // 94
  '▲', // 95
  '▼', // 96
  '▶', // 97
  '◀', // 98
  '▀', // 99
  '▄', // 100
  '▌', // 101
  '▐', // 102
  '■', // 103
  '◻', // 104
  '↖', // 105
  '↗', // 106
  '↙', // 107
  '↘', // 108
  '⌐', // 109
  '╳', // 110
  '¿', // 111
  '∟', // 112
  '✧', // 113
  '⌃', // 114
  '⌄', // 115
  '☸', // 116
  '▦', // 117
  '☯', // 118
  '⚛', // 119
  '❀', // 120
  '═', // 121
  '◡', // 122
  '⟲', // 123
  '⊕', // 124
  '❴', // 125
  '❬', // 126
  'Ⅾ', // 127
  '◦', // 128
];

it('covers every DMC 606 description with a distinct, plausible glyph', () => {
  expect(DESCRIPTION_SYMBOLS).toHaveLength(128);
  // One glyph per description, none reused.
  expect(new Set(DESCRIPTION_SYMBOLS).size).toBe(DESCRIPTION_SYMBOLS.length);
  // Every mapped glyph is actually auto-assignable from the pool.
  const pool = new Set(PALETTE_SYMBOLS);
  for (const glyph of DESCRIPTION_SYMBOLS) {
    expect(pool.has(glyph)).toBe(true);
  }
  // Pool still satisfies the symbol contract for all 561+ entries.
  expect(PALETTE_SYMBOLS.length).toBeGreaterThanOrEqual(561);
  expect(new Set(PALETTE_SYMBOLS).size).toBe(PALETTE_SYMBOLS.length);
  for (const glyph of PALETTE_SYMBOLS) {
    expect(glyph.length).toBeGreaterThan(0);
    expect(glyph.length).toBeLessThanOrEqual(MAX_PALETTE_SYMBOL_LENGTH);
    expect(isAlphanumericSymbol(glyph)).toBe(false);
  }
});

it('keeps the pool emoji-free: no denied codepoint and no U+FE0E anywhere', () => {
  // All 39 codepoints removed when the pool went emoji-free: the 15
  // Emoji_Presentation=Yes defaults plus the 24 user-curated glyphs that
  // still read as emoji-default. A plain U+FE0E in any entry would also
  // (re-)pin presentation, so the whole pool and the golden set must be
  // free of it.
  const denied = new Set<number>([
    0x1f4a7, // 💧 droplet
    0x1f514, // 🔔 bell
    0x1f33e, // 🌾 ear of rice
    0x1f41a, // 🐚 spiral shell
    0x1f6a9, // 🚩 triangular flag
    0x231a, // ⌚ watch
    0x231b, // ⌛ hourglass
    0x2604, // ☄ comet
    0x2607, // ☇ lightning
    0x2608, // ☈ thunderstorm
    0x2609, // ☉ sun
    0x260a, // ☊ ascending node
    0x260b, // ☋ descending node
    0x260c, // ☌ conjunction
    0x260d, // ☍ opposition
    0x260e, // ☎ black telephone
    0x2614, // ☔ umbrella with rain drops
    0x2615, // ☕ hot beverage
    0x2646, // ♆ neptune
    0x2655, // ♕ white chess queen
    0x265f, // ♟ black chess pawn
    0x266a, // ♪ eighth note
    0x266f, // ♯ music sharp sign
    0x2690, // ⚐ white flag
    0x2691, // ⚑ black flag
    0x2694, // ⚔ crossed swords
    0x2698, // ⚘ flower
    0x26a1, // ⚡ high voltage
    0x26b1, // ⚱ funeral urn
    0x26f3, // ⛳ flag in hole
    0x2702, // ✂ scissors
    0x2705, // ✅ check mark button
    0x2708, // ✈ airplane
    0x2709, // ✉ envelope
    0x270e, // ✎ lower right pencil
    0x270f, // ✏ pencil
    0x2728, // ✨ sparkles
    0x2b1b, // ⬛ black large square
    0x2b1c // ⬜ white large square
  ]);
  for (const glyph of PALETTE_SYMBOLS) {
    for (const code of [...glyph].map((unit) => unit.codePointAt(0) as number)) {
      expect(denied.has(code), `emoji-default codepoint U+${code.toString(16).toUpperCase()} re-entered the pool`).toBe(false);
    }
    expect(glyph.includes('\uFE0E'), 'pool entries must not carry U+FE0E').toBe(false);
  }
  for (const glyph of DESCRIPTION_SYMBOLS) {
    expect(glyph.includes('\uFE0E'), 'golden entries must not carry U+FE0E').toBe(false);
  }
});
