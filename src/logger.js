// ═══════════════════════════════════════════════════════════════
// Logger central — pino con formato bonito en desarrollo
// ═══════════════════════════════════════════════════════════════
import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.log_level,
  base: { app: "winny-bot" },
  timestamp: () => `,"time":"${new Date().toISOString()}"`
});
