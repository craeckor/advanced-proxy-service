import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Logger } from '../util/logger.ts';

/**
 * Graceful shutdown.
 *
 * The awkward part of shutting down an HTTP server is that idle keep-alive
 * connections will never close on their own — the client is holding them open
 * and has no reason to let go. `server.close()` therefore waits forever unless
 * those sockets are tracked and destroyed explicitly, which is what this does.
 */
export class GracefulShutdown {
  readonly #server: Server;
  readonly #logger: Logger;
  readonly #graceMs: number;
  readonly #sockets = new Set<Socket>();
  #shuttingDown = false;
  #forced = false;

  constructor(server: Server, logger: Logger, graceMs: number) {
    this.#server = server;
    this.#logger = logger;
    this.#graceMs = graceMs;

    server.on('connection', (socket: Socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });

    // Resume any socket that Node paused so the server can still be stopped.
    server.on('request', (request) => {
      if (this.#shuttingDown && !request.headers['connection']?.includes('keep-alive')) {
        this.#logger.debug('request arrived during shutdown');
      }
    });
  }

  /** True once shutdown has started; used to make readiness probes fail. */
  get isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /**
   * Stop accepting new connections, let in-flight requests finish, then force
   * close whatever is left after the grace period.
   */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;

    const stopped = new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });

    // Idle keep-alive sockets will not close by themselves, so give them a
    // moment to finish any in-flight exchange and then drop them.
    const timer = setTimeout(() => {
      if (this.#sockets.size === 0) return;
      this.#logger.warn({ sockets: this.#sockets.size }, 'forcing close of remaining sockets');
      this.#forced = true;
      for (const socket of this.#sockets) socket.destroy();
    }, this.#graceMs);

    // Do not hold the process open purely for this timer.
    timer.unref?.();

    await stopped;
    clearTimeout(timer);

    if (!this.#forced) {
      for (const socket of this.#sockets) socket.destroy();
    }
    this.#sockets.clear();
    this.#logger.info('http server closed');
  }
}
