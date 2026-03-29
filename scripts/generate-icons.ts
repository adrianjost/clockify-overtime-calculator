#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const projectRoot = import.meta.dir + "/..";
const logoSvgPath = join(projectRoot, "icon-source.svg");
const iconsetDir = join(projectRoot, "icon.iconset");

// Create directories
mkdirSync(iconsetDir, { recursive: true });

// Sizes needed for macOS iconset
const sizes = [16, 32, 64, 128, 256, 512, 1024];

console.log("📦 Generating macOS icon set from SVG...");

// Try to convert SVG to PNG using available tools
let convertTool = "convert"; // ImageMagick

// Check what's available
try {
  execSync("which rsvg-convert", { stdio: "ignore" });
  convertTool = "rsvg-convert";
} catch {
  try {
    execSync("which convert", { stdio: "ignore" });
    convertTool = "convert";
  } catch {
    console.error(
      "❌ Error: Neither ImageMagick (convert) nor librsvg (rsvg-convert) is installed",
    );
    console.error("   On macOS, install with: brew install imagemagick");
    console.error("   Or: brew install librsvg");
    process.exit(1);
  }
}

console.log(`Using ${convertTool} for SVG to PNG conversion...`);

// Convert SVG to PNG at various sizes
for (const size of sizes) {
  for (const scale of [1, 2]) {
    const actualSize = size * scale;
    const outputSize = `${size}x${size}`;
    const scaleSuffix = scale === 2 ? "@2x" : "";
    const filename = `icon_${outputSize}${scaleSuffix}.png`;
    const outputPath = join(iconsetDir, filename);

    console.log(`  Converting to ${filename} (${actualSize}x${actualSize})...`);

    try {
      if (convertTool === "convert") {
        execSync(
          `convert -density 300 -resize ${actualSize}x${actualSize} -background none "${logoSvgPath}" "${outputPath}"`,
          {
            stdio: "pipe",
          },
        );
      } else {
        execSync(
          `rsvg-convert -w ${actualSize} -h ${actualSize} "${logoSvgPath}" -o "${outputPath}"`,
          {
            stdio: "pipe",
          },
        );
      }
    } catch (error) {
      console.error(`Failed to convert ${filename}`);
      console.error(`Command: ${convertTool}`);
      process.exit(1);
    }
  }
}

console.log("✅ Icons generated successfully!");
console.log(`   Generated: ${iconsetDir}`);
