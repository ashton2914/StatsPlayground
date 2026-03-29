import { useThemeStore, ThemeMode } from "@/stores/useThemeStore";

interface Props {
  onClose: () => void;
}

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

export function PreferencesDialog({ onClose }: Props) {
  const { mode, setMode } = useThemeStore();

  return (
    <div className="sp-dialog-overlay" onClick={onClose}>
      <div className="sp-dialog sp-dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="sp-dialog-title">首选项</div>
        <div className="sp-dialog-body">
          <label className="sp-dialog-label">外观主题</label>
          <div className="pref-theme-group">
            {themeOptions.map((opt) => (
              <label key={opt.value} className="pref-theme-option">
                <input
                  type="radio"
                  name="theme"
                  value={opt.value}
                  checked={mode === opt.value}
                  onChange={() => setMode(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="sp-dialog-actions">
          <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
