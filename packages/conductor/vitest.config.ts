import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Engine and HTTP tests launch simulator subprocesses. Parallel files can
    // legitimately cross Vitest's 5 s default on a busy research host, while
    // 15 s remains short enough to expose a stalled lifecycle promptly.
    testTimeout: 15_000,
  },
});
