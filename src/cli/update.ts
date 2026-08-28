import { execSync } from "child_process";
import { VERSION } from "./index.js";

export async function updateApp(): Promise<void> {
  console.log(`  Current version: ${VERSION}`);
  console.log("  Checking for updates (npm)...");
  try {
    const current = execSync("npm view opencode-remote version", {
      encoding: "utf-8",
      timeout: 20000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    console.log(`  Latest: ${current}`);
    const latest = await execSync("npm view opencode-remote dist-tags.latest", {
      encoding: "utf-8",
      timeout: 20000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const [cMaj, cMin] = VERSION.split(".").map(Number);
    const [lMaj, lMin] = latest.split(".").map(Number);
    if (lMaj > cMaj || (lMaj === cMaj && lMin > cMin)) {
      console.log("  New version available. Run:");
      console.log("    npm i -g opencode-remote");
      console.log("  Or to update the local install:");
      console.log("    npm update -g opencode-remote");
    } else {
      console.log("  You are up to date.");
    }
  } catch {
    console.log("  Could not reach npm. If you installed from a local folder, rebuild with:");
    console.log("    npm run build");
  }
}