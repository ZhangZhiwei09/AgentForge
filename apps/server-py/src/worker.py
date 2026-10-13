"""Run the Python knowledge ingestion worker."""

import asyncio
import signal
import sys

from arq.worker import Worker, get_kwargs

if __name__ == "__main__":
    from src.dev import configure_environment

    configure_environment()

from src.jobs.ingestion import WorkerSettings


class IngestionWorker(Worker):
    async def close(self) -> None:
        # ARQ 0.28 assumes SIGUSR1 exists even when signal handlers are disabled.
        portable_shutdown = not hasattr(signal, "SIGUSR1") and not self._handle_signals
        if portable_shutdown:
            self.handle_sig(signal.SIGTERM)
            self._handle_signals = True
        try:
            await super().close()
        finally:
            if portable_shutdown:
                self._handle_signals = False


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    IngestionWorker(**get_kwargs(WorkerSettings), handle_signals=sys.platform != "win32").run()
