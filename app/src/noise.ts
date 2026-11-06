// Сильное шумоподавление голоса: нейросеть RNNoise (Xiph) прямо в приложении.
// Обычное шумоподавление браузера убирает ровный фон, а RNNoise глушит и
// клавиатуру, вентилятор, шум улицы. Работает у каждого на своём микрофоне.
//
// Пакет @sapphi-red/web-noise-suppressor (MIT): RNNoise в AudioWorklet.

import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

export type NoiseMode = "standard" | "strong";

export const PROCESSOR_NAME = "rnnoise";

let wasm: Promise<ArrayBuffer> | null = null;
const prepared = new WeakSet<BaseAudioContext>();

export class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = PROCESSOR_NAME;
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private node?: RnnoiseWorkletNode;
  private output?: MediaStreamAudioDestinationNode;

  async init(opts: AudioProcessorOptions) {
    const ctx = opts.audioContext;
    wasm ??= loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
    const wasmBinary = await wasm;
    if (!prepared.has(ctx)) {
      await ctx.audioWorklet.addModule(rnnoiseWorkletPath);
      prepared.add(ctx);
    }
    this.source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
    this.output = ctx.createMediaStreamDestination();
    this.source.connect(this.node);
    this.node.connect(this.output);
    this.processedTrack = this.output.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.source?.disconnect();
    this.node?.disconnect();
    (this.node as unknown as { destroy?: () => void } | undefined)?.destroy?.();
    this.processedTrack?.stop();
    this.source = this.node = this.output = undefined;
    this.processedTrack = undefined;
  }
}
