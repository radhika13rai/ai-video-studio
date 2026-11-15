import { DISPLAY_FONT_PATH } from "@avs/contracts";
import { DISPLAY_FAMILY, isDisplayFontReady, setDisplayFontReady } from "./theme";

/**
 * Loads the display font (Lilita One, a pinned vendor file) with the FontFace API before the
 * first graphics frame is drawn. Returns false, and headlines use bold Inter, when it can't load.
 */
export async function loadDisplayFont(base = "", timeoutMs = 8000): Promise<boolean> {
  if (isDisplayFontReady()) return true;
  if (typeof FontFace === "undefined") return false;
  const fonts: FontFaceSet | undefined =
    typeof document !== "undefined"
      ? document.fonts
      : (globalThis as unknown as { fonts?: FontFaceSet }).fonts;
  if (!fonts) return false;
  try {
    const face = new FontFace(DISPLAY_FAMILY, `url(${base}/vendor/${DISPLAY_FONT_PATH})`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = await Promise.race([
      face.load(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("font timed out")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    fonts.add(loaded);
    setDisplayFontReady(true);
    return true;
  } catch {
    return false;
  }
}
