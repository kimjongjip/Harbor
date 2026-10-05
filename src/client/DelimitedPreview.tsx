import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { parseDelimited } from "./preview-delimited";

function columnName(index: number) {
  let name = "";
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

export function DelimitedPreview({
  text,
  delimiter,
}: {
  text: string;
  delimiter: "," | "\t";
}) {
  const parsed = useMemo(
    () => parseDelimited(text, delimiter),
    [text, delimiter],
  );
  const [header, setHeader] = useState(true);
  const [page, setPage] = useState(0);
  const columnCount = parsed.columnCount;
  const columns = Math.min(columnCount, 50);
  const offset = header && parsed.rows.length ? 1 : 0;
  const count = Math.max(0, parsed.rows.length - offset);
  const pageSize = 100;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const start = currentPage * pageSize;
  const rows = parsed.rows.slice(offset + start, offset + start + pageSize);
  return (
    <div className="delimited-preview">
      <div className="delimited-toolbar">
        <label>
          <input
            type="checkbox"
            checked={header}
            onChange={(event) => {
              setHeader(event.target.checked);
              setPage(0);
            }}
          />
          첫 행을 제목으로
        </label>
        <span>
          {Math.max(0, parsed.rowCount - offset).toLocaleString()}행 ·{" "}
          {columnCount.toLocaleString()}열
        </span>
      </div>
      {parsed.malformed && (
        <p className="preview-data-notice" role="status">
          닫히지 않거나 잘못된 따옴표가 있습니다. 원문 보기에서 확인할 수
          있습니다.
        </p>
      )}
      {columnCount > columns && (
        <p className="preview-data-notice">
          처음 {columns}개 열을 표시합니다. 전체 열은 원문 보기나 다운로드로
          확인하세요.
        </p>
      )}
      {parsed.rowCount > parsed.rows.length && (
        <p className="preview-data-notice">
          처음 {parsed.rows.length.toLocaleString()}행을 미리 봅니다. 전체 행은
          원문 보기나 다운로드로 확인하세요.
        </p>
      )}
      <div
        className="delimited-scroll"
        tabIndex={0}
        aria-label="데이터 표 스크롤"
      >
        {parsed.rows.length ? (
          <table
            className="delimited-table"
            aria-label={delimiter === "\t" ? "TSV 데이터" : "CSV 데이터"}
          >
            <thead>
              <tr>
                <th className="delimited-row-number" scope="col">
                  행
                </th>
                {Array.from({ length: columns }, (_, index) => (
                  <th scope="col" key={index}>
                    {header
                      ? parsed.rows[0]?.[index] || columnName(index)
                      : columnName(index)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={start + index}>
                  <th className="delimited-row-number" scope="row">
                    {offset + start + index + 1}
                  </th>
                  {Array.from({ length: columns }, (_, column) => (
                    <td key={column}>{row[column] || ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="preview-empty-data">빈 파일입니다.</p>
        )}
      </div>
      {pages > 1 && (
        <div className="delimited-pagination">
          <span>
            {start + 1}–{Math.min(start + pageSize, count)} /{" "}
            {count.toLocaleString()}행
          </span>
          <button
            className="icon-button"
            aria-label="이전 데이터 페이지"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <button
            className="icon-button"
            aria-label="다음 데이터 페이지"
            disabled={currentPage + 1 >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
