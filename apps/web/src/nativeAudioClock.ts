/** A source-free HTML control clock driven by AVPlayer. Assigning currentTime
 * must never make WKWebView seek/download a second copy of the audiobook. */
export class NativeAudioControlClock {
  private position: number;
  private duration = NaN;
  private ready = false;
  private readonly audio: HTMLAudioElement;
  private readonly originals = new Map<string, PropertyDescriptor | undefined>();

  constructor(audio: HTMLAudioElement, source: string, position: number) {
    this.audio = audio;
    this.position = Number.isFinite(position) ? Math.max(0, position) : 0;
    const properties: PropertyDescriptorMap = {
      currentTime: { get: () => this.position, set: (value: number) => {
        if (Number.isFinite(value)) this.position = Math.max(0, value);
      } },
      duration: { get: () => this.duration },
      currentSrc: { get: () => source },
      readyState: { get: () => this.ready ? 1 : 0 },
      seeking: { get: () => false }
    };
    for (const [key, descriptor] of Object.entries(properties)) {
      this.originals.set(key, Object.getOwnPropertyDescriptor(audio, key));
      Object.defineProperty(audio, key, { ...descriptor, configurable: true });
    }
  }

  /** Announce metadata once, only after native playback has completed its resume seek. */
  updateMetadata(duration: number): boolean {
    if (Number.isFinite(duration) && duration > 0) this.duration = duration;
    const first = !this.ready;
    this.ready = true;
    return first;
  }

  destroy() {
    for (const [key, descriptor] of this.originals) {
      if (descriptor) Object.defineProperty(this.audio, key, descriptor);
      else Reflect.deleteProperty(this.audio, key);
    }
    this.originals.clear();
  }
}
