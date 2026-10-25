// Display-only hint for the owner's member list. User-Agent is self-reported and never used for authorization.
export function deviceLabel(ua: string | null) {
  if (!ua) return "不明な端末";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "不明な端末";
  const browser = /Line\//.test(ua) ? "LINE内ブラウザ" : /Edg\//.test(ua) ? "Edge" : /Firefox\/|FxiOS\//.test(ua) ? "Firefox" : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os} · ${browser}` : os;
}
export const CLAIM_WINDOW = 3 * 86400000;
