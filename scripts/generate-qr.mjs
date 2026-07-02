// Generates print-ready QR codes for event landing pages (SVG + high-res PNG).
// Add a new location by adding an entry to TARGETS below — nothing else changes.
//
// Usage:
//   node scripts/generate-qr.mjs
//
// Output goes to marketing/qr/<slug>.svg and marketing/qr/<slug>-2048.png

import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import QRCode from "qrcode";

const TARGETS = [
  { slug: "crunch-aloma", url: "https://app.trainwilco.com/crunch/aloma" },
];

const OPTIONS = {
  errorCorrectionLevel: "H", // tabletop signs get glare/damage — max redundancy
  margin: 4, // quiet zone, in modules
  color: { dark: "#000000", light: "#FFFFFF" },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "marketing", "qr");

async function main() {
  await mkdir(outDir, { recursive: true });

  const written = [];
  for (const { slug, url } of TARGETS) {
    const svgPath = path.join(outDir, `${slug}.svg`);
    const pngPath = path.join(outDir, `${slug}-2048.png`);

    await QRCode.toFile(svgPath, url, { ...OPTIONS, type: "svg" });
    await QRCode.toFile(pngPath, url, { ...OPTIONS, type: "png", width: 2048 });

    written.push(svgPath, pngPath);
  }

  console.log("QR codes generated:\n");
  for (const file of written) {
    const { size } = await stat(file);
    console.log(`  ${file}  (${size.toLocaleString()} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
