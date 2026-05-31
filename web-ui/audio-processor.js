// PCM-capture worklet. The render quantum is 128 frames (~2.7 ms @48 кГц), and
// posting every quantum flooded the WebSocket/gRPC stream with ~375 tiny
// messages per second. We accumulate ~100 ms of audio before posting so the
// downstream sends ~10 well-sized chunks per second instead — matching
// Yandex SpeechKit's recommended chunk size and cutting per-frame overhead.
const CHUNK_DURATION_MS = 100;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the AudioContext's native rate (e.g. 48000). Downsampling
    // to 16 кГц happens on the main thread; here we buffer at native rate.
    this.chunkSize = Math.max(128, Math.round(sampleRate * (CHUNK_DURATION_MS / 1000)));
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
  }

  process(inputs) {
    const inputChannel = inputs[0]?.[0];

    if (!inputChannel) {
      return true;
    }

    let read = 0;
    while (read < inputChannel.length) {
      const space = this.chunkSize - this.offset;
      const take = Math.min(space, inputChannel.length - read);
      this.buffer.set(inputChannel.subarray(read, read + take), this.offset);
      this.offset += take;
      read += take;

      if (this.offset === this.chunkSize) {
        // Transfer a copy so the worklet keeps reusing `this.buffer`.
        this.port.postMessage(this.buffer.slice(0));
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
