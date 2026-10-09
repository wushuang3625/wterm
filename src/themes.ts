import { configStorage } from './config-storage';
import type { ITheme } from "@xterm/xterm";

type UiTheme = [string,string,string,string,string,string,string,string,string,string];
export interface WtermTheme { id:string; name:string; ui:UiTheme; terminal:ITheme; }

const palette = (background:string, foreground:string, accent:string, selection:string, ansi?:Partial<ITheme>):ITheme => ({
  background, foreground, cursor:accent, cursorAccent:background, selectionBackground:selection,
  black:"#3b4048", red:"#e06c75", green:"#98c379", yellow:"#e5c07b", blue:accent,
  magenta:"#c678dd", cyan:"#56b6c2", white:"#c8d1dc", brightBlack:"#6b7280",
  brightRed:"#ff8787", brightGreen:"#7bd88f", brightYellow:"#ffd866", brightBlue:"#82aaff",
  brightMagenta:"#d2a8ff", brightCyan:"#89ddff", brightWhite:foreground,
  ...ansi
});

const data:[string,string,UiTheme,Partial<ITheme>?][] = [
  ["github-dark","GitHub Dark",["#0d1117","#161b22","#21262d","#30363d","#e6edf3","#8b949e","#58a6ff","#3fb950","#d29922","#f85149"]],
  ["github-light","GitHub Light",["#ffffff","#f6f8fa","#eaeef2","#d0d7de","#1f2328","#656d76","#0969da","#1a7f37","#9a6700","#cf222e"]],
  ["dracula","Dracula",["#282a36","#21222c","#343746","#44475a","#f8f8f2","#a8a8b3","#bd93f9","#50fa7b","#f1fa8c","#ff5555"]],
  ["nord","Nord",["#2e3440","#3b4252","#434c5e","#4c566a","#eceff4","#aeb8c6","#88c0d0","#a3be8c","#ebcb8b","#bf616a"]],
  ["solarized-dark","Solarized Dark",["#002b36","#073642","#0b4654","#285660","#eee8d5","#93a1a1","#268bd2","#859900","#b58900","#dc322f"]],
  ["solarized-light","Solarized Light",["#fdf6e3","#eee8d5","#e5ddc7","#d4cbb2","#586e75","#839496","#268bd2","#859900","#b58900","#dc322f"]],
  ["one-dark","One Dark",["#282c34","#21252b","#2f343d","#3e4451","#abb2bf","#7f848e","#61afef","#98c379","#e5c07b","#e06c75"]],
  ["monokai","Monokai",["#272822","#1e1f1c","#34352f","#49483e","#f8f8f2","#a8a897","#66d9ef","#a6e22e","#e6db74","#f92672"]],
  ["tokyo-night","Tokyo Night",["#1a1b26","#16161e","#24283b","#414868","#c0caf5","#787c99","#7aa2f7","#9ece6a","#e0af68","#f7768e"]],
  ["gruvbox-dark","Gruvbox Dark",["#282828","#1d2021","#3c3836","#504945","#ebdbb2","#a89984","#83a598","#b8bb26","#fabd2f","#fb4934"]],
  ["eye-green","护眼绿 Evergreen",["#e2eee1","#d8e7d7","#cfe0ce","#b8ccb6","#3b4a38","#556352","#38726d","#437347","#796725","#924b3d"],{black:"#4a5546",red:"#a25149",green:"#48733e",yellow:"#786822",blue:"#426d8c",magenta:"#825d7d",cyan:"#357271",white:"#626b62",brightBlack:"#5e6d5a",brightRed:"#945951",brightGreen:"#4a733c",brightYellow:"#77682d",brightBlue:"#456d8a",brightMagenta:"#7d6077",brightCyan:"#3b716e"}],
  ["warm-paper","暖纸 Warm Paper",["#f7f0dd","#f1e8d1","#eae0c3","#d9cca6","#5a5145","#676256","#356e79","#607331","#856825","#9e4936"],{black:"#60584c",red:"#b74838",green:"#5f7329",yellow:"#886721",blue:"#426f82",magenta:"#935a7b",cyan:"#4d755a",white:"#6b6d5f",brightBlack:"#726c5a",brightRed:"#a45647",brightGreen:"#62732d",brightYellow:"#80692c",brightBlue:"#4c717e",brightMagenta:"#896077",brightCyan:"#507459"}],
  ["everforest","林间 Everforest",["#2f383e","#333d43","#3c464c","#465259","#d3c6aa","#afb5aa","#7fbbb3","#a7c080","#dbbc7f","#e7a29e"],{black:"#9fa29d",red:"#e68686",green:"#a7c080",yellow:"#dbbc7f",blue:"#7fbbb3",magenta:"#d699b6",cyan:"#83c092",white:"#d3c6aa",brightBlack:"#abb8ad",brightRed:"#ec8283",brightGreen:"#aecf85",brightYellow:"#e5c887",brightBlue:"#96c9bd",brightMagenta:"#e0abcb",brightCyan:"#9fd3bb"}],
  ["zenburn","暖墨 Zenburn",["#3f3f3f","#464642","#4f4f4f","#5f5f58","#dcdccc","#c4c3b4","#8cd0d3","#8fbd8f","#e0cf9f","#dabcb5"],{black:"#adaca3",red:"#d0a09e",green:"#9bb297",yellow:"#d0bf8f",blue:"#8db3b1",magenta:"#dd95c5",cyan:"#8cd0d3",white:"#dcdccc",brightBlack:"#bbb9ac",brightRed:"#dca3a3",brightGreen:"#bfebbf",brightYellow:"#f0dfaf",brightBlue:"#94bff3",brightMagenta:"#ec93d3",brightCyan:"#93e0e3"}]
];

export const WTERM_THEMES:WtermTheme[] = data.map(([id,name,ui,ansi]) => ({
  id,name,ui,terminal:palette(ui[0],ui[4],ui[6],ui[3],ansi)
}));

export function currentThemeId():string {
  const saved=configStorage.getItem("wterm_theme");
  return WTERM_THEMES.some(theme=>theme.id===saved) ? saved! : "github-dark";
}
export function getTheme(id=currentThemeId()):WtermTheme {
  return WTERM_THEMES.find(theme=>theme.id===id) || WTERM_THEMES[0];
}
export function getTerminalTheme():ITheme {
  const theme = getTheme(document.documentElement.dataset.theme || currentThemeId()).terminal;
  const transparent = Number(configStorage.getItem("wterm_background_opacity") ?? "1") < .999 ||
    !!configStorage.getItem("wterm_background_image") || (configStorage.getItem("wterm_window_effect") ?? "none") !== "none";
  return transparent ? { ...theme, background: "#00000000" } : theme;
}
const isLightBg=(hex:string):boolean=>{
  const n=parseInt(hex.slice(1),16);
  return ((n>>16)+((n>>8)&255)+(n&255))/3>140;
};
export function applyTheme(id=currentThemeId(),persist=false):void {
  const theme=getTheme(id), [bg,panel,hover,border,text,dim,accent,green,yellow,red]=theme.ui;
  const style=document.documentElement.style;
  for (const [key,value] of Object.entries({"--bg":bg,"--bg-panel":panel,"--bg-hover":hover,"--border":border,"--text":text,"--text-dim":dim,"--accent":accent,"--green":green,"--yellow":yellow,"--red":red})) style.setProperty(key,value);
  style.setProperty("color-scheme",isLightBg(bg)?"light":"dark");
  document.documentElement.dataset.theme=theme.id;
  if(persist) configStorage.setItem("wterm_theme",theme.id);
  window.dispatchEvent(new CustomEvent("wterm-theme-changed"));
}
export function setTheme(id:string):void { applyTheme(id,true); }
