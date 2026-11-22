declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    output?: number;
    active?: boolean;
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    start(when?: number): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    schedule(change: StretchSchedule): Promise<unknown>;
    latency(): Promise<number>;
    configure(options: { blockMs?: number; intervalMs?: number; splitComputation?: boolean; preset?: string }): Promise<unknown>;
  }

  export default function SignalsmithStretch(context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
}
