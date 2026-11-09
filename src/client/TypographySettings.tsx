import { RotateCcw } from "lucide-react";
import { Modal } from "./Dialogs";
import { useTypography } from "./Typography";
import {
  terminalFontFamily,
  typographyBounds,
  type TypographySettings,
} from "./typography-settings";

export default function TypographySettingsDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const { settings, updateSettings, resetSettings } = useTypography();
  function slider(
    key: keyof typeof typographyBounds,
    label: string,
    unit: string,
  ) {
    return (
      <label className="typography-slider" key={key}>
        <span>
          {label}
          <output>
            {settings[key]}
            {unit}
          </output>
        </span>
        <input
          aria-label={label}
          type="range"
          {...typographyBounds[key]}
          value={settings[key]}
          onChange={(event) =>
            updateSettings({
              [key]: Number(event.target.value),
            } as Partial<TypographySettings>)
          }
        />
      </label>
    );
  }
  return (
    <Modal
      title="글꼴·읽기 설정"
      subtitle="바꾸는 즉시 반영하고, 이 컴퓨터의 다른 Harbor 창에도 함께 적용합니다."
      onClose={onClose}
      backdropClassName="typography-dialog"
    >
      <div className="typography-settings">
        <section>
          <h3>터미널</h3>
          <label className="typography-font-label">
            글꼴
            <select
              aria-label="터미널 글꼴"
              value={settings.terminalFont}
              onChange={(event) =>
                updateSettings({
                  terminalFont: event.target
                    .value as TypographySettings["terminalFont"],
                })
              }
            >
              <option value="d2coding">
                D2Coding · 한글·영문 고정폭 (앱 포함)
              </option>
              <option value="cascadia">Cascadia Code · 설치된 경우</option>
              <option value="consolas">Consolas · 설치된 경우</option>
            </select>
          </label>
          {slider("terminalSize", "터미널 글자 크기", "px")}
          {slider("terminalLineHeight", "터미널 줄 간격", "배")}
          <pre
            className="typography-terminal-sample"
            style={{
              fontFamily: terminalFontFamily(settings.terminalFont),
              fontSize: settings.terminalSize,
              lineHeight: settings.terminalLineHeight,
            }}
          >
            한글과 English가 함께 보이는 답변입니다.{"\n"}0O 1Il 0123456789 ·
            ┌──────┐{"\n"}const result = value !== null;
          </pre>
        </section>
        <section>
          <h3>문서·답변</h3>
          <p>
            앱에 포함된 Pretendard를 사용합니다. 문서 창의 Ctrl+휠 확대는 별도로
            유지됩니다.
          </p>
          {slider("documentSize", "문서 글자 크기", "px")}
          {slider("documentLineHeight", "문서 줄 간격", "배")}
          <p className="typography-document-sample">
            조금 긴 설명도 편하게 읽을 수 있도록 글자 크기와 줄 사이의 여백을
            조절하세요. 글자를 선택하고 복사하는 방식은 그대로입니다.
          </p>
        </section>
        <section>
          <h3>메뉴·목록</h3>
          {slider("uiSize", "메뉴·목록 글자 크기", "px")}
          <p>터미널과 문서의 글자 크기에는 영향을 주지 않습니다.</p>
        </section>
      </div>
      <footer className="modal-footer">
        <button type="button" className="button" onClick={resetSettings}>
          <RotateCcw size={15} />
          기본값 복원
        </button>
        <button type="button" className="button primary" onClick={onClose}>
          완료
        </button>
      </footer>
    </Modal>
  );
}
