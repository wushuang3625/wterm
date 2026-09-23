import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type WindowEffect = "none" | "blur" | "acrylic" | "mica";

function backgroundUrl(value: string): string {
  if (!value) return "none";
  if (/^(https?:|data:|asset:)/i.test(value)) return `url("${value.replace(/"/g, "\\\"")}")`;
  try {
    return `url("${convertFileSrc(value).replace(/"/g, "\\\"")}")`;
  } catch {
    return "none";
  }
}

export function appearanceUsesTransparency(): boolean {
  const opacity = Number(localStorage.getItem("wterm_background_opacity") ?? "1");
  return opacity < 0.999 || !!localStorage.getItem("wterm_background_image") ||
    (localStorage.getItem("wterm_window_effect") ?? "none") !== "none";
}

export async function applyAppearance(): Promise<void> {
  const root = document.documentElement;
  const opacity = Math.max(0.2, Math.min(1, Number(localStorage.getItem("wterm_background_opacity") ?? "1") || 1));
  const image = localStorage.getItem("wterm_background_image") ?? "";
  const imageOpacity = Math.max(0, Math.min(1, Number(localStorage.getItem("wterm_background_image_opacity") ?? "0.22") || 0.22));
  const effect = (localStorage.getItem("wterm_window_effect") ?? "none") as WindowEffect;
  root.style.setProperty("--wterm-surface-opacity", String(opacity));
  root.style.setProperty("--wterm-background-image", backgroundUrl(image));
  root.style.setProperty("--wterm-background-image-opacity", String(imageOpacity));
  root.classList.toggle("wterm-transparent", appearanceUsesTransparency());
  root.classList.toggle("wterm-has-background-image", !!image);
  window.dispatchEvent(new CustomEvent("wterm-appearance-changed"));
  try {
    await invoke("set_window_effect", { label: getCurrentWindow().label, effect });
  } catch (error) {
    console.warn("应用窗口效果失败", error);
  }
}
