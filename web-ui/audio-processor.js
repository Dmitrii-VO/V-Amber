class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const inputChannel = inputs[0]?.[0];

    if (!inputChannel) {
      return true;
    }

    this.port.postMessage(inputChannel.slice(0));
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
