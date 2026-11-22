/**
 * Which GPU the browser renders with. On a laptop with two GPUs, Windows runs
 * browsers on the integrated one to save battery unless the user picks the
 * other in Windows' graphics settings. A page cannot choose: it can only ask
 * for high performance, and the browser follows what Windows assigned.
 */
export interface GpuInfo {
  /** The GPU drawing the visuals (WebGL), or null when the browser hides it. */
  visual: string | null;
  /** The GPU the stem AI gets (WebGPU, asking for high performance), or null without WebGPU. */
  ai: string | null;
  /** True when either is an integrated GPU (Intel, AMD APU), where a laptop may have a faster one. */
  integrated: boolean;
}

/**
 * Readable name from a WebGL renderer string:
 * "ANGLE (Intel, Intel(R) UHD Graphics (0x00009A68) Direct3D11 vs_5_0 ps_5_0, D3D11)" → "Intel(R) UHD Graphics".
 */
export function gpuName(renderer: string): string {
  // Names contain brackets themselves ("Intel(R)", "Radeon(TM)"), so the name
  // ends at the device id, the API name, or the comma before the version.
  const angle = /^ANGLE \([^,]+,\s*(.+?)(?:\s*\(0x[0-9a-f]+\))?\s*(?:Direct3D|OpenGL ES|Vulkan|,)/i.exec(renderer);
  return (angle?.[1] ?? renderer).replace(/^ANGLE Metal Renderer:\s*/i, '').trim();
}

export function isIntegrated(name: string): boolean {
  // Intel Arc A-series are graphics cards; every other Intel GPU is built in.
  if (/intel/i.test(name)) return !/Arc(\(TM\))?\s*A\d/i.test(name);
  return /Radeon(\(TM\))?\s*Graphics|Vega \d+ Graphics/i.test(name);
}

interface AdapterInfo {
  vendor?: string;
  architecture?: string;
  description?: string;
}

type WebGpu = { requestAdapter(o?: { powerPreference?: string }): Promise<{ info?: AdapterInfo } | null> };

/** WebGPU often hides the model name; vendor and architecture are enough to tell. */
function adapterName(info: AdapterInfo): string | null {
  if (info.description) return info.description;
  if (!info.vendor) return null;
  const vendor = info.vendor === 'nvidia' ? 'NVIDIA' : info.vendor === 'amd' ? 'AMD' : info.vendor[0].toUpperCase() + info.vendor.slice(1);
  return info.architecture ? `${vendor} (${info.architecture})` : vendor;
}

let cached: Promise<GpuInfo> | null = null;

export function gpuInfo(): Promise<GpuInfo> {
  cached ??= (async () => {
    let visual: string | null = null;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2', { powerPreference: 'high-performance' }) ?? c.getContext('webgl', { powerPreference: 'high-performance' });
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      if (gl && ext) visual = gpuName(String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)));
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* no WebGL: the stage already says so */
    }
    let ai: string | null = null;
    try {
      const gpu = (navigator as Navigator & { gpu?: WebGpu }).gpu;
      const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
      ai = adapter?.info ? adapterName(adapter.info) : null;
    } catch {
      /* no WebGPU */
    }
    const names = [visual, ai].filter((n): n is string => !!n);
    return { visual, ai, integrated: names.some(isIntegrated) };
  })();
  return cached;
}

export const isWindows = () => /Windows/i.test(navigator.userAgent);
