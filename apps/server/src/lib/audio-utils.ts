// Audio utility functions — format conversion for voice pipeline
// PCM 16-bit mono → WAV (required by Whisper API)

/**
 * Convert raw PCM audio buffer to WAV format by adding a 44-byte header.
 * Whisper API requires WAV format; browser captures raw PCM.
 */
export function pcmToWav(
  pcmBuffer: Buffer,
  sampleRate: number = 16000,
  numChannels: number = 1,
  bitsPerSample: number = 16,
): Buffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const header = Buffer.alloc(headerSize);

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(totalSize - 8, 4); // file size - 8
  header.write("WAVE", 8);

  // fmt subchunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // subchunk size (16 for PCM)
  header.writeUInt16LE(1, 20); // audio format (1 = PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data subchunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Estimate audio duration from buffer size.
 */
export function estimateDuration(
  bufferSize: number,
  sampleRate: number = 16000,
  numChannels: number = 1,
  bitsPerSample: number = 16,
): number {
  const bytesPerSecond = (sampleRate * numChannels * bitsPerSample) / 8;
  return bufferSize / bytesPerSecond;
}
