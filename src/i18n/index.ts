import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import vi from "./locales/vi.json";

export type Locale = "en" | "zh-CN" | "zh-TW" | "vi";

export const SUPPORTED_LOCALES: Array<{ code: Locale; label: string }> = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "vi", label: "Tiếng Việt" },
];

const STORAGE_KEY = "sp-locale";

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function getStoredLocale(): Locale {
  if (!hasLocalStorage()) {
    return "en";
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "zh-CN" || stored === "zh-TW" || stored === "vi") {
    return stored;
  }
  return "en";
}

export function persistLocale(loc: Locale) {
  if (!hasLocalStorage()) {
    return;
  }
  localStorage.setItem(STORAGE_KEY, loc);
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "zh-CN": { translation: zhCN },
      "zh-TW": { translation: zhTW },
      vi: { translation: vi },
    },
    lng: getStoredLocale(),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
  });

/** Map app locale to BCP-47 used by Intl APIs (e.g. toLocaleString). */
export function bcp47For(loc: Locale): string {
  switch (loc) {
    case "zh-CN": return "zh-CN";
    case "zh-TW": return "zh-TW";
    case "vi": return "vi-VN";
    default: return "en-US";
  }
}

export default i18n;
