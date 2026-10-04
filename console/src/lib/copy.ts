/**
 * Console UI copy that must read the same everywhere it appears (same
 * discipline as lib/badges: one string, every surface quotes it).
 *
 * NO_ANSWER_TEXT is shown instead of an answer bubble when a stored turn has
 * no reply text at all — refusals/streams that died before any output on
 * pre-persist builds. The refusal path now persists its own message, so this
 * only ever covers turns from before, and genuinely empty records.
 */
export const NO_ANSWER_TEXT = "no reply recorded — the turn was refused, or it failed before generation.";