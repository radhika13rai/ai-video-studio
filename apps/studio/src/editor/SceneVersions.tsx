import type { Asset } from "@avs/contracts";
import type { Clip } from "@avs/schemas";
import { useState } from "react";
import { assetUrl } from "../services/api";

/**
 * Regenerating one scene (ADR 047): a new image (optionally from an edited prompt) or another
 * stock clip. Earlier versions stay available; choosing one is an undoable edit.
 */
export function SceneVersions({
  clip,
  assets,
  onRegenerate,
  onUse,
}: {
  clip: Clip;
  assets: Asset[];
  onRegenerate: (what: "image" | "footage", prompt: string | null) => Promise<void>;
  onUse: (asset: Asset) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"image" | "footage" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versions = assets.filter(
    (a) => a.scene_id === clip.scene_id && (a.asset_type === "image" || a.asset_type === "video"),
  );
  const run = async (what: "image" | "footage") => {
    setBusy(what);
    setError(null);
    try {
      await onRegenerate(what, prompt.trim() || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make a new version.");
    } finally {
      setBusy(null);
    }
  };
  const inUse = (a: Asset) => a.id === clip.image_asset_id || a.id === clip.video_asset_id;
  return (
    <div className="versions">
      <h3 className="panel-title">New version of this scene</h3>
      <textarea
        aria-label="Describe the new picture"
        rows={2}
        maxLength={1000}
        placeholder={`Optional: describe it (default: “${clip.description.slice(0, 60)}”)`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="row-actions">
        <button
          type="button"
          className="btn small"
          disabled={busy !== null}
          onClick={() => void run("image")}
        >
          {busy === "image" ? "Making an image…" : "New image"}
        </button>
        <button
          type="button"
          className="btn small"
          disabled={busy !== null}
          onClick={() => void run("footage")}
        >
          {busy === "footage" ? "Finding a clip…" : "Another stock clip"}
        </button>
      </div>
      {error && (
        <p className="bad small" role="alert">
          {error}
        </p>
      )}
      {versions.length > 1 && (
        <div className="version-list" aria-label="Versions">
          {versions.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className={`version${inUse(a) ? " active" : ""}`}
              aria-pressed={inUse(a)}
              aria-label={`Use ${a.asset_type === "video" ? "clip" : "image"} version ${i + 1}`}
              onClick={() => onUse(a)}
            >
              {a.asset_type === "video" ? (
                <span className="version-clip">🎬</span>
              ) : (
                <img src={assetUrl(a.project_id, a.id)} alt="" loading="lazy" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
