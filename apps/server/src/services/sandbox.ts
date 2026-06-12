// Sandbox Manager — Docker-based code execution sandbox
// Creates isolated containers with no network, limited memory/CPU, and read-only filesystem
import Docker from "dockerode";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, mkdtemp, rm } from "fs/promises";
import { logger } from "@agentforge/logger";
import { settings } from "../config.js";

// ---- Types ----

export type SandboxLanguage = "python" | "javascript";

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

// ---- Platform Detection ----

function getDockerSocketPath(): string {
  // Windows uses named pipe, Linux/macOS use Unix socket
  if (process.platform === "win32") {
    return "//./pipe/docker_engine";
  }
  return "/var/run/docker.sock";
}

// ---- Manager ----

export class SandboxManager {
  private docker: Docker;
  private available: boolean;

  constructor() {
    this.available = false;
    try {
      const socketPath = getDockerSocketPath();
      this.docker = new Docker({ socketPath });
      this.available = true;
      logger.info({ socketPath }, "SandboxManager initialized");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown";
      logger.warn(
        { error: msg },
        "Docker not available — sandbox tools disabled",
      );
      this.docker = null as unknown as Docker; // Will throw if used
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  async executeCode(
    language: SandboxLanguage,
    code: string,
    timeoutSec?: number,
  ): Promise<SandboxResult> {
    if (!this.available) {
      throw new Error(
        "Docker is not available. Sandbox code execution requires Docker. " +
          "Ensure Docker Desktop is running and the Docker socket is accessible.",
      );
    }

    if (!code || code.trim().length === 0) {
      throw new Error("Code cannot be empty");
    }

    if (code.length > 50_000) {
      throw new Error(
        `Code too long (${code.length} chars). Maximum is 50,000 characters.`,
      );
    }

    const effectiveTimeout = (timeoutSec || settings.sandboxTimeoutSec) * 1000;
    const start = Date.now();

    // Create temp directory for the code file
    const workDir = await mkdtemp(join(tmpdir(), "agentforge-sandbox-"));
    const ext = language === "python" ? "py" : "js";
    const codeFile = join(workDir, `main.${ext}`);

    try {
      // Write code to temp file
      await writeFile(codeFile, code, "utf-8");

      // Build command based on language
      const cmd =
        language === "python"
          ? ["python", "-u", `/code/main.${ext}`] // -u for unbuffered output
          : ["node", `/code/main.${ext}`];

      // Normalize path for Docker bind mount (Windows → /c/Users/...)
      const mountSource = workDir.replace(/\\/g, "/");

      // Create container with security constraints
      const container = await this.docker.createContainer({
        Image: settings.sandboxImage,
        Cmd: cmd,
        Env: ["PYTHONUNBUFFERED=1", "NODE_OPTIONS=--max-old-space-size=128"],
        HostConfig: {
          ReadonlyRootfs: true,
          NetworkMode: "none",
          Memory: settings.sandboxMemoryMb * 1024 * 1024,
          CpuShares: settings.sandboxCpuShares,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          Binds: [`${mountSource}:/code:ro`],
          Tmpfs: {
            "/tmp": "rw,noexec,nosuid,size=64m",
          },
          AutoRemove: false,
        },
        Labels: {
          "agentforge.sandbox": "true",
          "agentforge.sandbox_id": randomUUID(),
        },
      });

      logger.debug(
        { language, codeLength: code.length, containerId: container.id },
        "Sandbox container created",
      );

      // Start container
      await container.start();

      // Set up timeout
      let timedOut = false;
      const timeoutHandle = setTimeout(async () => {
        timedOut = true;
        try {
          await container.kill({ signal: "SIGKILL" });
        } catch {
          // Container may already be stopped
        }
        logger.warn(
          { language, containerId: container.id },
          "Sandbox execution timed out",
        );
      }, effectiveTimeout);

      // Wait for container to finish
      const waitResult = await container.wait();
      clearTimeout(timeoutHandle);

      const duration = Date.now() - start;
      const exitCode = waitResult.StatusCode;

      // Collect stdout/stderr logs
      const logStream = await container.logs({
        stdout: true,
        stderr: true,
        tail: 5000, // Max 5000 lines of logs
      });

      // Parse Docker log stream (multiplexed: 8 byte header + frame)
      // Header: [stream_type(1)][0][0][0][0][0][0][0][size(4)]
      const { stdout, stderr } = this.demuxLogs(logStream);

      // Truncate outputs
      const maxOutput = 10_000;
      const truncStdout =
        stdout.length > maxOutput
          ? stdout.slice(0, maxOutput) +
            `\n... (truncated from ${stdout.length} chars)`
          : stdout;
      const truncStderr =
        stderr.length > maxOutput
          ? stderr.slice(0, maxOutput) +
            `\n... (truncated from ${stderr.length} chars)`
          : stderr;

      // Clean up container
      try {
        await container.remove({ force: true });
      } catch (removeErr: unknown) {
        const rmMsg =
          removeErr instanceof Error ? removeErr.message : "Unknown";
        logger.warn(
          { containerId: container.id, error: rmMsg },
          "Failed to remove sandbox container",
        );
      }

      logger.info(
        {
          language,
          exitCode,
          durationMs: duration,
          timedOut,
          stdoutLen: stdout.length,
          stderrLen: stderr.length,
        },
        "Sandbox execution complete",
      );

      return {
        stdout: truncStdout,
        stderr: truncStderr,
        exitCode,
        durationMs: duration,
        timedOut,
      };
    } finally {
      // Clean up temp directory
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Demux Docker log stream: separates stdout (type 1) and stderr (type 2) frames
  private demuxLogs(buffer: Buffer): { stdout: string; stderr: string } {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let offset = 0;

    while (offset < buffer.length) {
      // Each frame: [1 byte stream type][3 bytes padding][4 bytes size (big-endian)]
      if (offset + 8 > buffer.length) break;

      const streamType = buffer[offset]; // 1 = stdout, 2 = stderr
      const frameSize = buffer.readUInt32BE(offset + 4);
      offset += 8;

      if (offset + frameSize > buffer.length) break;

      const chunk = buffer
        .subarray(offset, offset + frameSize)
        .toString("utf-8");

      if (streamType === 1) {
        stdoutChunks.push(chunk);
      } else if (streamType === 2) {
        stderrChunks.push(chunk);
      }
      // Stream type 0 (stdin) and 3+ are ignored

      offset += frameSize;
    }

    return {
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  }
}

// Export singleton instance
export const sandboxManager = new SandboxManager();
