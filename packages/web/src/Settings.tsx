import { useState } from 'react'
import { LOCALES, useI18n, type Locale } from './i18n'

/**
 * Settings popover: a gear button in the top bar. Language lives here today;
 * future per-user config (theme, density, defaults) slots into the same panel.
 */
export function Settings() {
  const { locale, setLocale, t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div className="ps-settings">
      <button
        className="ps-iconbtn"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('settings.title')}
        title={t('settings.title')}
      >
        ⚙
      </button>
      {open && (
        <>
          <div className="ps-settings-backdrop" onClick={() => setOpen(false)} />
          <div className="ps-settings-panel" role="dialog" aria-label={t('settings.title')}>
            <div className="ps-settings-title">{t('settings.title')}</div>
            <label className="ps-settings-row">
              <span>{t('settings.language')}</span>
              <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                {LOCALES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
    </div>
  )
}
