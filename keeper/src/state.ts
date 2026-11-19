// Where each scan stopped, so a tick only reads the blocks it has not seen.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { E, Q, STATE_FILE } from "./config.js";

export type State = { qoreBlock: number; ethBlock: number; lastReportAt?: number };

export function load(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  return { qoreBlock: Q.deployedAtBlock, ethBlock: E.deployedAtBlock };
}

export function save(s: State) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
