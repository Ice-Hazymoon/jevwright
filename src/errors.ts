/**
 * A problem the user fixes in their setup (config, flags, missing browser or key), not a test failure.
 * The CLI prints the message alone and exits with code 2.
 */
export class JevwrightError extends Error {
    override name = 'JevwrightError';
}
