#!/usr/bin/env node
/**
 * Applies Cadence's native Android overlay (Media3 service, SAF/MediaStore plugin,
 * adaptive launcher icons, ProGuard rules, edge-to-edge MainActivity, permissions, and
 * Kotlin unit tests) onto the Tauri-generated `src-tauri/gen/android` project.
 *
 * Safe to run repeatedly (100% idempotent).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const GEN_ANDROID = path.join(ROOT, "src-tauri", "gen", "android");
const OVERLAY_DIR = path.join(ROOT, "src-tauri", "android-overlay");

function copyRecursive(srcDir, dstDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dstPath, { recursive: true });
      copyRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function patchBuildGradle(gradlePath) {
  let content = fs.readFileSync(gradlePath, "utf8");
  const compileSdkOverride = process.env.ANDROID_COMPILE_SDK?.trim();
  if (compileSdkOverride && /^\d+$/.test(compileSdkOverride)) {
    content = content
      .replace(/compileSdk\s*=\s*\d+/, `compileSdk = ${compileSdkOverride}`)
      .replace(/targetSdk\s*=\s*\d+/, `targetSdk = ${compileSdkOverride}`);
  }

  const marker = "// CADENCE_ANDROID_DEPS";
  if (!content.includes(marker)) {
    const depsBlock = `    ${marker}
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.media3:media3-exoplayer:1.10.1")
    implementation("androidx.media3:media3-session:1.10.1")
    implementation("androidx.media3:media3-common:1.10.1")
    testImplementation("org.json:json:20240303")
`;

    const target = "dependencies {";
    const idx = content.indexOf(target);
    if (idx === -1) {
      throw new Error(`Could not locate 'dependencies {' in ${gradlePath}`);
    }
    const insertAt = idx + target.length;
    content = `${content.slice(0, insertAt)}\n${depsBlock}${content.slice(insertAt)}`;
  }

  fs.writeFileSync(gradlePath, content, "utf8");
}

function patchManifest(manifestPath) {
  let xml = fs.readFileSync(manifestPath, "utf8");

  const permissions = [
    '<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />',
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />',
    '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '<uses-permission android:name="android.permission.WAKE_LOCK" />',
  ];

  const missingPerms = permissions.filter((line) => {
    const nameMatch = /android:name="([^"]+)"/.exec(line);
    return nameMatch && !xml.includes(nameMatch[1]);
  });

  if (missingPerms.length > 0) {
    xml = xml.replace(
      "<application",
      `${missingPerms.map((p) => `    ${p}`).join("\n")}\n\n    <application`
    );
  }

  if (!xml.includes("android:enableOnBackInvokedCallback=")) {
    xml = xml.replace(
      "<application\n",
      '<application\n        android:enableOnBackInvokedCallback="false"\n'
    );
    if (!xml.includes("android:enableOnBackInvokedCallback=")) {
      xml = xml.replace(
        "<application ",
        '<application android:enableOnBackInvokedCallback="false" '
      );
    }
  }

  if (!xml.includes("CadenceMediaService")) {
    const serviceBlock = `        <service
            android:name=".CadenceMediaService"
            android:exported="true"
            android:foregroundServiceType="mediaPlayback">
            <intent-filter>
                <action android:name="androidx.media3.session.MediaSessionService" />
            </intent-filter>
        </service>
`;
    xml = xml.replace("</application>", `${serviceBlock}    </application>`);
  }

  fs.writeFileSync(manifestPath, xml, "utf8");
}

function removeForeignMainActivities(mainDir, keepPath) {
  if (!fs.existsSync(mainDir)) return;
  for (const entry of fs.readdirSync(mainDir, { withFileTypes: true })) {
    const full = path.join(mainDir, entry.name);
    if (entry.isDirectory()) {
      removeForeignMainActivities(full, keepPath);
    } else if (entry.isFile() && entry.name === "MainActivity.kt" && full !== keepPath) {
      fs.unlinkSync(full);
    }
  }
}

function main() {
  if (!fs.existsSync(GEN_ANDROID)) {
    throw new Error(
      `Generated Android project not found at ${GEN_ANDROID}. Run 'npx tauri android init --ci --skip-targets-install' first.`
    );
  }

  const targetMainActivity = path.join(
    GEN_ANDROID,
    "app",
    "src",
    "main",
    "java",
    "app",
    "cadence",
    "player",
    "MainActivity.kt"
  );
  removeForeignMainActivities(path.join(GEN_ANDROID, "app", "src", "main"), targetMainActivity);

  copyRecursive(OVERLAY_DIR, GEN_ANDROID);

  const gradlePath = path.join(GEN_ANDROID, "app", "build.gradle.kts");
  const manifestPath = path.join(GEN_ANDROID, "app", "src", "main", "AndroidManifest.xml");

  patchBuildGradle(gradlePath);
  patchManifest(manifestPath);

  console.log("[prepare-android-project] Cadence Android overlay applied cleanly.");
}

main();
