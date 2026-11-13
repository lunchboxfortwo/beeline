export const WAVEFORM_BARS = 64;
/** One new bar every 80ms, regardless of microphone delivery cadence. */
const BAR_INTERVAL = 80;
const HEIGHT_RESPONSE = 60;

export type WaveformMotion = { phase: number; heights: number[]; targets: number[] };

export function initialWaveformMotion(): WaveformMotion {
    return { phase: 0, heights: [], targets: [] };
}

/** Runs on the animation thread. Split at bar boundaries so cadence cannot alter speed or easing. */
export function advanceWaveform(current: WaveformMotion, elapsed: number, target: number): WaveformMotion {
    'worklet';
    let phase = current.phase;
    const heights = current.heights.slice();
    const targets = current.targets.slice();
    if (!heights.length) {
        heights.push(2);
        targets.push(target);
    }
    targets[targets.length - 1] = target;
    // A suspended app resumes where it stopped instead of replaying minutes of history.
    let remaining = Math.max(0, Math.min(elapsed, BAR_INTERVAL * WAVEFORM_BARS));
    while (remaining > 0) {
        const step = Math.min(remaining, BAR_INTERVAL - phase);
        const mix = 1 - Math.exp(-step / HEIGHT_RESPONSE);
        for (let index = 0; index < heights.length; index += 1) {
            heights[index] += (targets[index] - heights[index]) * mix;
        }
        phase += step;
        remaining -= step;
        if (phase >= BAR_INTERVAL) {
            phase = 0;
            heights.push(2);
            targets.push(target);
            if (heights.length > WAVEFORM_BARS) {
                heights.shift();
                targets.shift();
            }
        }
    }
    return { phase, heights, targets };
}

export function waveformOffset(phase: number, pitch: number): number {
    'worklet';
    return -phase / BAR_INTERVAL * pitch;
}
