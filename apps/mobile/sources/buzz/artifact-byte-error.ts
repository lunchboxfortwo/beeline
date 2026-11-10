/** A failure after file authority was established belongs to the file surface,
 * rather than the shared socket connection banner. */
export class ArtifactByteError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The file could not be opened.');
    this.name = 'ArtifactByteError';
  }
}
