/**
 * Where the lyrics sit on screen, so the visual engine can quiet the light
 * behind them. The lyrics overlay writes it, the engine reads it every frame;
 * plain numbers in CSS pixels from the top-left, so neither side imports the other.
 */
export interface VeilBox {
  /** Centre of the text. */
  x: number;
  y: number;
  /** Half the text's width and height. */
  hw: number;
  hh: number;
  /** 0..1: how much to quiet the picture (less while the song rests between lines). */
  strength: number;
}

export const lyricVeil: { box: VeilBox | null } = { box: null };
