/**
 * webgpu-audio-bridge
 *
 * Lock-free SPSC SharedArrayBuffer ring for streaming WebGPU compute output
 * into AudioWorklets — the control-rate-GPU / audio-rate-CPU pattern.
 *
 * See README.md for the architectural pattern and use cases.
 */

export {
  Float64RingBuffer,
  RING_HEADER_BYTES,
  RING_HEADER_LANES,
  RING_FRAME_PRELUDE,
  type RingFrameHeader,
  type RingAllocation,
} from "./Float64RingBuffer.js";
