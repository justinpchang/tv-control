import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPs } from "./windowsLauncher.js";

// Captures the full virtual desktop (all monitors, so the TV is included even
// when it is not the primary display). Windows only.
export async function captureScreenshot(): Promise<Buffer> {
  if (process.platform !== "win32") throw new Error("screenshots require Windows");
  const out = join(tmpdir(), "tv-shot.png");
  await runPs([
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
    "$bmp = New-Object System.Drawing.Bitmap([int]$bounds.Width, [int]$bounds.Height);",
    "$g = [System.Drawing.Graphics]::FromImage($bmp);",
    "$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);",
    "$g.Dispose();",
    `$bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "$bmp.Dispose();",
    "Write-Output 'SHOT OK';",
  ].join("\n"));
  return readFile(out);
}
