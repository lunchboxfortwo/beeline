import { DaemonService } from '../daemon-service.js';

/** Tests reach the daemon exactly as a helper does: every operation through
 * `execute`, authorized by membership and the queue item it names. */
export class HelperDaemonService extends DaemonService {}
