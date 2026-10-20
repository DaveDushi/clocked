import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run the real platform checks. Missing build tools are failures, never passes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const scopes = process.argv.slice(2);
const selected = scopes.length ? scopes : ["worker", "android", "ios-core", "ios-build"];
const valid = new Set(["worker", "android", "ios-core", "ios-build"]);
if (selected.some((scope) => !valid.has(scope))) {
  console.error("Usage: node mobile/verify.mjs [worker android ios-core ios-build]");
  process.exit(2);
}
const results = [];
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  return result.status === 0;
}
function has(command) {
  return spawnSync(windows ? "where.exe" : "which", [command], { stdio: "ignore" }).status === 0;
}
for (const scope of selected) {
  console.log(`\nRunning ${scope}`);
  let passed = false;
  if (scope === "worker") {
    passed = windows
      ? run("cmd.exe", ["/d", "/c", "npm.cmd run verify"], join(root, "worker"))
      : run("npm", ["run", "verify"], join(root, "worker"));
  } else if (scope === "android") {
    const cwd = join(root, "mobile", "android");
    const env = { ...process.env };
    const localJdks = join(cwd, ".tools", "jdk");
    if (!env.JAVA_HOME && existsSync(localJdks)) {
      const candidate = readdirSync(localJdks).map((name) => join(localJdks, name))
        .find((path) => existsSync(join(path, "bin", windows ? "java.exe" : "java")));
      if (candidate) env.JAVA_HOME = candidate;
    }
    if (!env.ANDROID_HOME && existsSync(join(cwd, ".tools", "sdk"))) {
      env.ANDROID_HOME = join(cwd, ".tools", "sdk");
    }
    passed = windows
      ? run("cmd.exe", ["/d", "/c", ".\\gradlew.bat --no-daemon testDebugUnitTest lintDebug assembleDebug"], cwd, env)
      : run("sh", ["./gradlew", "--no-daemon", "testDebugUnitTest", "lintDebug", "assembleDebug"], cwd, env);
  } else if (scope === "ios-core") {
    const python = windows && has("py") ? "py" : has("python3") ? "python3" : "python";
    const staticPassed = run(python, ["mobile/ios/scripts/validate_static.py"]);
    const localSwift = has("swift");
    const corePassed = localSwift
      ? run("swift", ["test", "--package-path", "mobile/ios/ClockedCore"])
      : run("docker", ["run", "--rm", "-v", `${root}:/repo`, "-w", "/repo", "swift:6.1-noble", "swift", "test", "--package-path", "mobile/ios/ClockedCore", "--scratch-path", "/tmp/clocked-verify-build"]);
    const bridgePassed = localSwift
      ? run("bash", ["mobile/ios/scripts/typecheck_bridge.sh"])
      : run("docker", ["run", "--rm", "-v", `${root}:/repo`, "-w", "/repo", "swift:6.1-noble", "bash", "mobile/ios/scripts/typecheck_bridge.sh"]);
    passed = staticPassed && corePassed && bridgePassed;
  } else if (process.platform === "darwin") {
    const cwd = join(root, "mobile", "ios");
    passed = run("xcodegen", ["generate"], cwd)
      && run("xcodebuild", ["build", "-project", "Clocked.xcodeproj", "-scheme", "Clocked", "-configuration", "Release", "-destination", "generic/platform=iOS", "CODE_SIGNING_ALLOWED=NO"], cwd);
  } else {
    console.error("BLOCKED: ios-build requires macOS and Xcode. Use the mobile-ios CI workflow on a Mac runner.");
  }
  results.push({ scope, passed });
}
console.log("\nVerification results:", JSON.stringify(results));
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
