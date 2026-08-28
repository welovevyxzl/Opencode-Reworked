import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fakeHome = mkdtempSync(join(tmpdir(), "ocr-test-home-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;