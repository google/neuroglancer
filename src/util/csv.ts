/**
 * @license
 * Copyright 2025 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// TODO, support nested properties

export function toCSV(data: any[]): string {
  const header: string[] = [];
  const csvRows: string[][] = [];
  const addValue = (row: string[], key: string, val: unknown) => {
    if (Array.isArray(val)) {
      for (const [i, v] of val.entries()) {
        addValue(row, `${key}[${i}]`, v);
      }
    } else {
      let columnIdx = header.indexOf(key);
      if (columnIdx === -1) {
        columnIdx = header.push(key.includes(",") ? `"${key}"` : key) - 1;
      }
      row[columnIdx] = `${val}`;
    }
  };
  for (const obj of data) {
    const row: string[] = [];
    for (const [key, val] of Object.entries(obj)) {
      if (val !== undefined) {
        addValue(row, key, val);
      }
    }
    csvRows.push(row);
  }
  const sortedHeader = header.slice().sort();
  const sortMap = new Map<number, number>();
  for (let i = 0; i < header.length; i++) {
    sortMap.set(sortedHeader.indexOf(header[i]), i);
  }
  const sortedRows = csvRows.map((row) => {
    const sortedRow = new Array(sortedHeader.length).fill("");
    for (let i = 0; i < sortedRow.length; i++) {
      sortedRow[i] = row[sortMap.get(i)!];
    }
    return sortedRow;
  });
  return [sortedHeader, ...sortedRows].map((row) => row.join(",")).join("\n");
}

export function fromCSV(csv: string) {
  const rows = csv.split("\n");
  if (rows.length < 2) return []; // need a header and a row
  const result: any[] = [];
  const [header, ...dataRows] = rows;
  const columnNames = header.split(",");
  for (const row of dataRows) {
    const columns = row.split(",");
    const obj = {};
    for (const [index, value] of columns.entries()) {
      if (value === "") continue;
      const column = columnNames[index];
      if (column === undefined) {
        throw new Error("bad csv");
      }
      const [name, _] = column.split("[");
      let currentTarget: any = obj;
      let key: string = name;
      const arrayIndices = column
        .matchAll(/\[(\d+)\]/g)
        .map(([_, index]) => index);
      for (const index of arrayIndices) {
        currentTarget = currentTarget[key] = currentTarget[key] ?? [];
        key = index;
      }
      currentTarget[key] = value;
    }
    result.push(obj);
  }
  return result;
}
