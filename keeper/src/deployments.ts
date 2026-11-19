// Addresses of every deployment, one JSON per chain, committed so the app and the keeper read the same record.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const file = (chain: "qorechain" | "sepolia") => join(ROOT, `deployments/${chain === "qorechain" ? "qorechain-diana" : "ethereum-sepolia"}.json`);

export type Deployment = Record<string, any>;
export function loadDeployments(chain: "qorechain" | "sepolia"): Deployment {
  return existsSync(file(chain)) ? JSON.parse(readFileSync(file(chain), "utf8")) : {};
}
export function saveDeployments(chain: "qorechain" | "sepolia", d: Deployment) {
  mkdirSync(dirname(file(chain)), { recursive: true });
  writeFileSync(file(chain), JSON.stringify(d, null, 2) + "\n");
}
