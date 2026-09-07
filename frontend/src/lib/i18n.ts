import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { resources } from './locales'
import { isEmbeddedMode } from './embedded/config'
import { resolveInitialLanguage } from './embedded/language'

// RWV2-42（Fork #45）：嵌入式构建在 init 时即固定 en-US（lng 显式给出时
// LanguageDetector 不生效），无首帧语言闪烁/竞态；standalone 构建保持
// 原多语言检测行为。
const initialLanguage = resolveInitialLanguage(isEmbeddedMode())

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    lng: initialLanguage,
    resources,
    fallbackLng: 'en-US',
    interpolation: {
      escapeValue: false, // react already safes from xss
    },
    react: {
      useSuspense: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  })

export default i18n
