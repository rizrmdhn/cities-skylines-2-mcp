import { defineConfig } from "vitest/config"

// Tests run in plain Node: nothing they import may load "electron" at runtime (type imports are fine).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
