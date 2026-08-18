/**
 * The web-side boost chain.
 *
 * `HTMLMediaElement.volume` cannot exceed 1, so lifting a book that was
 * mastered quiet means routing the element through Web Audio and using a gain
 * node. That routing is one-way and it is subject to the media CORS rules: a
 * source node fed by a cross-origin stream the element loaded opaquely outputs
 * silence, not sound. So the chain is only ever built for streams that can
 * legitimately be tapped, and every other case stays on the untouched element
 * path with its own `volume`.
 *
 * iOS never uses this: AVPlayer is the only audible engine there and applies
 * its own gain (see `nativeAudio.ts`).
 */

type Chain = {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  limiter: DynamicsCompressorNode;
  limiting: boolean;
  element: HTMLAudioElement;
};

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Whether a boost can be applied to this stream at all.
 *
 * Same-origin covers the deployments that matter: the server hosting the web
 * app itself, the macOS shell pointed at that server, offline downloads, and
 * imported device files. A separately hosted frontend loads media opaquely and
 * has to settle for the element's own volume.
 */
export function streamCanBeBoosted(streamUrl: string | null | undefined): boolean {
  if (!streamUrl || typeof window === "undefined") return false;
  if (!audioContextConstructor()) return false;
  try {
    const url = new URL(streamUrl, window.location.href);
    if (url.protocol === "blob:" || url.protocol === "data:" || url.protocol === "file:") {
      return true;
    }
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

export class PlaybackGainChain {
  private context: AudioContext | null = null;
  private chain: Chain | null = null;
  private gain = 1;
  private unavailable = false;

  /**
   * Whether this element's output is going through the chain. The player mounts
   * a fresh <audio> per track, so this is asked per element rather than once.
   */
  isAttachedTo(element: HTMLAudioElement | null | undefined) {
    return !!element && this.chain?.element === element;
  }

  /**
   * Route `element` through the chain, building it on first use. Call this from
   * a user gesture: an AudioContext created outside one starts suspended, and a
   * suspended context would make the routed element inaudible rather than loud.
   *
   * Returns false when the chain could not be built, in which case the caller
   * must keep applying volume to the element directly.
   */
  attach(element: HTMLAudioElement): boolean {
    if (this.unavailable) return false;
    if (this.chain?.element === element) {
      this.resume();
      return true;
    }

    const Context = audioContextConstructor();
    if (!Context) {
      this.unavailable = true;
      return false;
    }

    try {
      const context = (this.context ??= new Context());
      // One source node per element. The player replaces its <audio> on every
      // track change and a source node cannot be moved to another element.
      const source = context.createMediaElementSource(element);
      const gain = context.createGain();
      gain.gain.value = this.gain;
      // A brick wall a hair below full scale. Lifting a quiet book eventually
      // drives its loudest passages past the ceiling; catching them costs a
      // little dynamic range instead of handing the listener hard clipping.
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;

      source.connect(gain);
      limiter.connect(context.destination);

      this.chain?.source.disconnect();
      this.chain = { context, source, gain, limiter, limiting: false, element };
      this.route();
      this.resume();
      return true;
    } catch (error) {
      // Only a missing engine is permanent. One element refusing to be tapped —
      // it was already routed, a StrictMode remount handed us the same node —
      // must not disable boosting for every later track in the session.
      if (!this.context) this.unavailable = true;
      void error;
      return false;
    }
  }

  setGain(gain: number) {
    this.gain = gain;
    if (!this.chain) return;
    const { context, gain: node } = this.chain;
    // Ramp rather than jump: a step change on a live signal is an audible click.
    node.gain.setTargetAtTime(gain, context.currentTime, 0.05);
    this.route();
  }

  /**
   * The limiter only earns its place while the book is actually boosted. A
   * listener who tries +12 dB, dislikes it and returns to Original must get the
   * untouched signal back, not a book quietly compressed for the rest of the
   * track because the chain cannot be torn down once attached.
   */
  private route() {
    const chain = this.chain;
    if (!chain) return;
    const shouldLimit = this.gain > 1;
    if (shouldLimit === chain.limiting) return;

    chain.gain.disconnect();
    if (shouldLimit) {
      chain.gain.connect(chain.limiter);
    } else {
      chain.gain.connect(chain.context.destination);
    }
    chain.limiting = shouldLimit;
  }

  /**
   * Autoplay policy suspends the context until a gesture, and iOS interrupts it
   * outright for a phone call. Anything that is not running is worth nudging.
   */
  resume() {
    const context = this.context;
    if (!context || context.state === "running" || context.state === "closed") return;
    void context.resume().catch(() => undefined);
  }
}
