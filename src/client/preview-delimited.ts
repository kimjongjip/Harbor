/** Read CSV/TSV records without treating quoted separators or newlines as cells. */
export function parseDelimited(text: string, delimiter: "," | "\t") {
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  let malformed = false;
  let cellLength = 0;
  let rowColumns = 0;
  let rowCount = 0;
  let columnCount = 0;
  const maxRows = 2000;
  const maxColumns = 100;
  const append = (value: string) => {
    if (rows.length < maxRows && rowColumns < maxColumns) cell += value;
    cellLength += value.length;
  };
  const endCell = () => {
    if (rows.length < maxRows && rowColumns < maxColumns) row.push(cell);
    rowColumns++;
    cell = "";
    cellLength = 0;
    closedQuote = false;
  };
  const endRow = () => {
    rowCount++;
    columnCount = Math.max(columnCount, rowColumns);
    if (rows.length < maxRows) rows.push(row);
    row = [];
    rowColumns = 0;
  };
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (quoted) {
      if (character !== '"') append(character);
      else if (input[i + 1] === '"') {
        append('"');
        i++;
      } else {
        quoted = false;
        closedQuote = true;
      }
      continue;
    }
    if (character === delimiter) endCell();
    else if (character === "\r" || character === "\n") {
      endCell();
      endRow();
      if (character === "\r" && input[i + 1] === "\n") i++;
    } else if (character === '"' && !cellLength && !closedQuote) quoted = true;
    else {
      if (character === '"' || closedQuote) malformed = true;
      append(character);
    }
  }
  if (quoted) malformed = true;
  if (
    cellLength ||
    rowColumns ||
    closedQuote ||
    (input && !/[\r\n]$/.test(input))
  ) {
    endCell();
    endRow();
  }
  return {
    rows,
    malformed,
    rowCount,
    columnCount,
    limited: rowCount > maxRows || columnCount > maxColumns,
  };
}
