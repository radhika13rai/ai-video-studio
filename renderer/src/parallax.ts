import type { DepthMap } from "./depth";

/**
 * Draws a picture with a "2.5D" camera move: each pixel is shifted in proportion to how near it
 * is (from the depth map), so the foreground slides against the background. Runs on the GPU
 * with WebGL 1, which every current phone and desktop browser has.
 */

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uImage;
uniform sampler2D uDepth;
uniform vec4 uCrop;      // x, y, w, h of the visible part of the image (0-1)
uniform vec2 uCam;       // camera offset (-1..1)
uniform float uStrength; // how far the nearest pixels move (fraction of the image)
uniform float uFocus;    // depth that stays still
void main() {
  vec2 uv = uCrop.xy + vUv * uCrop.zw;
  vec2 p = uv;
  // A few refinement steps: look up depth where the pixel will land, not where it started.
  for (int i = 0; i < 4; i++) {
    float d = texture2D(uDepth, clamp(p, 0.0, 1.0)).r;
    p = uv - uCam * uStrength * (d - uFocus);
  }
  gl_FragColor = texture2D(uImage, clamp(p, 0.0, 1.0));
}`;

export interface ParallaxView {
  /** Visible source rectangle in pixels of the image (from coverRect). */
  crop: { x: number; y: number; w: number; h: number };
  camera: [number, number];
}

interface SceneTextures {
  image: WebGLTexture;
  depth: WebGLTexture;
  width: number;
  height: number;
}

export class ParallaxRenderer {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private scenes = new Map<number, SceneTextures>();
  private loc: Record<string, WebGLUniformLocation | null>;

  static create(width: number, height: number): ParallaxRenderer | null {
    try {
      const canvas: OffscreenCanvas | HTMLCanvasElement =
        typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement("canvas"), { width, height });
      const gl = canvas.getContext("webgl", {
        preserveDrawingBuffer: true,
        antialias: false,
        premultipliedAlpha: false,
      }) as WebGLRenderingContext | null;
      if (!gl) return null;
      return new ParallaxRenderer(canvas, gl);
    } catch {
      return null;
    }
  }

  private constructor(canvas: OffscreenCanvas | HTMLCanvasElement, gl: WebGLRenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type) as WebGLShader;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram() as WebGLProgram;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`Shader link error: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.loc = Object.fromEntries(
      ["uImage", "uDepth", "uCrop", "uCam", "uStrength", "uFocus"].map((n) => [
        n,
        gl.getUniformLocation(program, n),
      ]),
    );
    gl.uniform1i(this.loc.uImage ?? null, 0);
    gl.uniform1i(this.loc.uDepth ?? null, 1);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  /** Uploads a scene's picture and depth (a flat map when depth is unavailable). */
  addScene(id: number, image: ImageBitmap, depth: DepthMap | null): void {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const img = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const dep = this.texture();
    const d = depth ?? { data: new Uint8Array([128]), width: 1, height: 1 };
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      d.width,
      d.height,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      d.data,
    );
    this.scenes.set(id, { image: img, depth: dep, width: image.width, height: image.height });
  }

  has(id: number): boolean {
    return this.scenes.has(id);
  }

  /** Renders one view of a scene into `this.canvas`. */
  draw(id: number, view: ParallaxView, strength = 0.03): OffscreenCanvas | HTMLCanvasElement {
    const gl = this.gl;
    const s = this.scenes.get(id);
    if (!s) throw new Error(`Scene ${id} has no textures`);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.image);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, s.depth);
    const c = view.crop;
    gl.uniform4f(
      this.loc.uCrop ?? null,
      c.x / s.width,
      c.y / s.height,
      c.w / s.width,
      c.h / s.height,
    );
    gl.uniform2f(this.loc.uCam ?? null, view.camera[0], view.camera[1]);
    gl.uniform1f(this.loc.uStrength ?? null, strength);
    gl.uniform1f(this.loc.uFocus ?? null, 0.35);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }

  dispose(): void {
    const gl = this.gl;
    for (const s of this.scenes.values()) {
      gl.deleteTexture(s.image);
      gl.deleteTexture(s.depth);
    }
    this.scenes.clear();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
