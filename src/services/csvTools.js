// ── Tool declarations (sent to Gemini so it knows what functions exist) ───────

// IMPORTANT NOTE embedded in every description:
// The user message always begins with "[CSV columns: col1, col2, ...]".
// Always copy column names character-for-character from that list.
// Never guess, abbreviate, or change capitalisation.

const COL_NOTE = 'Use the exact column name as it appears in the [CSV columns: ...] header at the top of the message — copy it character-for-character, preserving spaces and capitalisation.';

export const CSV_TOOL_DECLARATIONS = [
  {
    name: 'compute_column_stats',
    description:
      'Compute descriptive statistics (mean, median, std, min, max, count) for a numeric column. ' + COL_NOTE,
    parameters: {
      type: 'OBJECT',
      properties: {
        column: {
          type: 'STRING',
          description: 'Exact column name copied from [CSV columns: ...]. Example: if the header says "Favorite Count" pass "Favorite Count", not "favorite_count".',
        },
      },
      required: ['column'],
    },
  },
  {
    name: 'get_value_counts',
    description:
      'Count occurrences of each unique value in a column (for categorical data). ' + COL_NOTE,
    parameters: {
      type: 'OBJECT',
      properties: {
        column: {
          type: 'STRING',
          description: 'Exact column name copied from [CSV columns: ...]. ' + COL_NOTE,
        },
        top_n: { type: 'NUMBER', description: 'How many top values to return (default 10)' },
      },
      required: ['column'],
    },
  },
  {
    name: 'compute_correlation',
    description:
      'Compute the Pearson correlation coefficient between two numeric columns. ' + COL_NOTE,
    parameters: {
      type: 'OBJECT',
      properties: {
        column1: {
          type: 'STRING',
          description: 'First column name, copied exactly from [CSV columns: ...].',
        },
        column2: {
          type: 'STRING',
          description: 'Second column name, copied exactly from [CSV columns: ...].',
        },
      },
      required: ['column1', 'column2'],
    },
  },
  {
    name: 'filter_and_aggregate',
    description:
      'Filter rows where a text column contains a substring (case-insensitive), then compute an aggregation on a numeric column. ' +
      'filter_value is a substring — "mog" will match rows containing "Mog", "mogging", "mogmaxxing", etc. ' +
      COL_NOTE,
    parameters: {
      type: 'OBJECT',
      properties: {
        target_column: {
          type: 'STRING',
          description: 'Numeric column to aggregate — copied exactly from [CSV columns: ...].',
        },
        filter_column: {
          type: 'STRING',
          description: 'Text column to search — copied exactly from [CSV columns: ...].',
        },
        filter_value: {
          type: 'STRING',
          description: 'Substring to search for (case-insensitive). Partial matches are included — "mog" matches "mogging", "Mogmaxxing", etc.',
        },
        operation: {
          type: 'STRING',
          enum: ['mean', 'sum', 'count', 'min', 'max', 'median'],
          description: 'Aggregation operation (default: mean)',
        },
      },
      required: ['target_column', 'filter_column', 'filter_value'],
    },
  },
  {
    name: 'compare_keyword_engagement',
    description:
      'For each keyword, compare the mean engagement metric for rows whose text column CONTAINS the keyword (case-insensitive substring match) vs rows that do not. Returns a grouped bar chart. ' +
      COL_NOTE,
    parameters: {
      type: 'OBJECT',
      properties: {
        keywords: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'List of keywords/substrings to compare. Each is matched case-insensitively anywhere in the text column.',
        },
        text_column: {
          type: 'STRING',
          description: 'Column containing the text to search — copied exactly from [CSV columns: ...]. Leave blank to auto-detect.',
        },
        metric_column: {
          type: 'STRING',
          description: 'Numeric engagement column — copied exactly from [CSV columns: ...]. Leave blank to auto-detect.',
        },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'get_top_rows',
    description: 'Return the top N rows sorted by a column. ' + COL_NOTE,
    parameters: {
      type: 'OBJECT',
      properties: {
        sort_column: {
          type: 'STRING',
          description: 'Column to sort by — copied exactly from [CSV columns: ...].',
        },
        n: { type: 'NUMBER', description: 'Number of rows to return (default 10)' },
        ascending: { type: 'BOOLEAN', description: 'Sort ascending? Default false (highest first)' },
      },
      required: ['sort_column'],
    },
  },
];

// ── Parse a CSV line, respecting quoted fields ────────────────────────────────

const parseLine = (line) => {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
};

// ── Parse a full CSV text into an array of row objects ────────────────────────

export const parseCsvToRows = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseLine(lines[0]).map((h) => h.replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map((line) => {
    const vals = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (vals[i] || '').replace(/^"|"$/g, '');
    });
    return obj;
  });
  return { headers, rows };
};

// ── Column lookup (case-insensitive + whitespace-tolerant) ───────────────────
// Gemini often passes column names in a slightly different case than the CSV header.
// This finds the actual header key so the lookup always works.

const resolveCol = (rows, name) => {
  if (!rows.length || !name) return name;
  const keys = Object.keys(rows[0]);
  // 1. exact match
  if (keys.includes(name)) return name;
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const target = norm(name);
  // 2. normalised match
  return keys.find((k) => norm(k) === target) || name;
};

// ── Math helpers ──────────────────────────────────────────────────────────────

const numericValues = (rows, col) =>
  rows.map((r) => parseFloat(r[col])).filter((v) => !isNaN(v));

const median = (sorted) =>
  sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

const fmt = (n) => +n.toFixed(4);

// ── Dataset summary (auto-computed when CSV is loaded) ───────────────────────
// Returns a compact markdown string describing every column so Gemini always
// has exact column names, types, and value distributions in its context.

export const computeDatasetSummary = (rows, headers) => {
  if (!rows.length || !headers.length) return '';

  const lines = [`**Dataset: ${rows.length} rows × ${headers.length} columns**\n`];
  const numericCols = [];
  const categoricalCols = [];

  headers.forEach((h) => {
    const vals = rows.map((r) => r[h]).filter((v) => v !== '' && v !== undefined && v !== null);
    const numVals = vals.map((v) => parseFloat(v)).filter((v) => !isNaN(v));
    const numericRatio = numVals.length / (vals.length || 1);

    if (numericRatio >= 0.8 && numVals.length > 0) {
      const mean = numVals.reduce((a, b) => a + b, 0) / numVals.length;
      numericCols.push({
        name: h,
        count: numVals.length,
        mean: +mean.toFixed(2),
        min: Math.min(...numVals),
        max: Math.max(...numVals),
      });
    } else {
      const counts = {};
      vals.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
      const top = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([v, n]) => `${v} (${n})`)
        .join(', ');
      categoricalCols.push({ name: h, unique: Object.keys(counts).length, top });
    }
  });

  if (numericCols.length) {
    lines.push('**Numeric columns** (exact names — use these verbatim in tool calls):');
    numericCols.forEach((c) => {
      lines.push(`  • "${c.name}": mean=${c.mean}, min=${c.min}, max=${c.max}, n=${c.count}`);
    });
  }

  if (categoricalCols.length) {
    lines.push('\n**Categorical columns** (exact names — use these verbatim in tool calls):');
    categoricalCols.forEach((c) => {
      lines.push(`  • "${c.name}": ${c.unique} unique values — top: ${c.top}`);
    });
  }

  return lines.join('\n');
};

// ── Client-side tool executor ─────────────────────────────────────────────────

export const executeTool = (toolName, args, rows) => {
  const availableHeaders = rows.length ? Object.keys(rows[0]) : [];
  console.group(`[CSV Tool] ${toolName}`);
  console.log('args:', args);
  console.log('rows loaded:', rows.length);
  console.log('available headers:', availableHeaders);
  console.groupEnd();

  switch (toolName) {
    case 'compute_column_stats': {
      const col = resolveCol(rows, args.column);
      console.log(`[compute_column_stats] resolved column: "${args.column}" → "${col}"`);
      const vals = numericValues(rows, col);
      if (!vals.length)
        return { error: `No numeric values found in column "${col}". Available columns: ${availableHeaders.join(', ')}` };
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sorted = [...vals].sort((a, b) => a - b);
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      return {
        column: col,
        count: vals.length,
        mean: fmt(mean),
        median: fmt(median(sorted)),
        std: fmt(Math.sqrt(variance)),
        min: Math.min(...vals),
        max: Math.max(...vals),
      };
    }

    case 'get_value_counts': {
      const col = resolveCol(rows, args.column);
      console.log(`[get_value_counts] resolved column: "${args.column}" → "${col}"`);
      const topN = args.top_n || 10;
      const counts = {};
      rows.forEach((r) => {
        const v = r[col];
        if (v !== undefined && v !== '') counts[v] = (counts[v] || 0) + 1;
      });
      const sorted = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN);
      return {
        column: col,
        total_rows: rows.length,
        value_counts: Object.fromEntries(sorted),
      };
    }

    case 'compute_correlation': {
      const col1 = resolveCol(rows, args.column1);
      const col2 = resolveCol(rows, args.column2);
      console.log(`[compute_correlation] resolved: "${args.column1}"→"${col1}", "${args.column2}"→"${col2}"`);
      const pairs = rows
        .map((r) => [parseFloat(r[col1]), parseFloat(r[col2])])
        .filter(([a, b]) => !isNaN(a) && !isNaN(b));
      if (pairs.length < 2) return { error: 'Not enough numeric pairs to compute correlation' };
      const n = pairs.length;
      const m1 = pairs.reduce((s, p) => s + p[0], 0) / n;
      const m2 = pairs.reduce((s, p) => s + p[1], 0) / n;
      const cov = pairs.reduce((s, p) => s + (p[0] - m1) * (p[1] - m2), 0) / n;
      const s1 = Math.sqrt(pairs.reduce((s, p) => s + (p[0] - m1) ** 2, 0) / n);
      const s2 = Math.sqrt(pairs.reduce((s, p) => s + (p[1] - m2) ** 2, 0) / n);
      return {
        column1: col1,
        column2: col2,
        correlation: fmt(cov / (s1 * s2)),
        n_pairs: n,
      };
    }

    case 'filter_and_aggregate': {
      const targetCol = resolveCol(rows, args.target_column);
      const filterCol = resolveCol(rows, args.filter_column);
      const { filter_value, operation = 'mean' } = args;
      console.log(`[filter_and_aggregate] target:"${args.target_column}"→"${targetCol}", filter:"${args.filter_column}"→"${filterCol}"="${filter_value}"`);
      const filterLower = String(filter_value).toLowerCase();
      const filtered = rows.filter((r) =>
        String(r[filterCol] ?? '').toLowerCase().includes(filterLower)
      );
      if (!filtered.length)
        return { error: `No rows where ${filterCol} contains "${filter_value}" (case-insensitive). Available columns: ${availableHeaders.join(', ')}` };
      const vals = numericValues(filtered, targetCol);
      if (!vals.length)
        return { error: `No numeric values in "${targetCol}" for the filtered rows` };
      const opMap = {
        mean: () => vals.reduce((a, b) => a + b, 0) / vals.length,
        sum: () => vals.reduce((a, b) => a + b, 0),
        count: () => vals.length,
        min: () => Math.min(...vals),
        max: () => Math.max(...vals),
        median: () => median([...vals].sort((a, b) => a - b)),
      };
      return {
        filter: `${filterCol} = "${filter_value}"`,
        target_column: targetCol,
        operation,
        result: fmt((opMap[operation] || opMap.mean)()),
        matching_rows: filtered.length,
      };
    }

    case 'get_top_rows': {
      const sortCol = resolveCol(rows, args.sort_column);
      console.log(`[get_top_rows] resolved sort column: "${args.sort_column}" → "${sortCol}"`);
      const n = args.n || 10;
      const asc = args.ascending ?? false;
      const sorted = [...rows].sort((a, b) => {
        const av = parseFloat(a[sortCol]);
        const bv = parseFloat(b[sortCol]);
        if (!isNaN(av) && !isNaN(bv)) return asc ? av - bv : bv - av;
        return asc
          ? String(a[sortCol]).localeCompare(String(b[sortCol]))
          : String(b[sortCol]).localeCompare(String(a[sortCol]));
      });
      return { sort_column: sortCol, rows: sorted.slice(0, n) };
    }

    case 'compare_keyword_engagement': {
      const { keywords } = args;

      // Auto-detect text and metric columns if not provided
      const allHeaders = rows.length ? Object.keys(rows[0]) : [];
      const textCol =
        args.text_column ||
        allHeaders.find((h) => /^text$/i.test(h)) ||
        allHeaders.find((h) => /text|content|tweet|post|body/i.test(h)) ||
        allHeaders[0];
      const metricCol =
        args.metric_column ||
        allHeaders.find((h) => /favorite.?count|likes?_count|like_count/i.test(h)) ||
        allHeaders.find((h) => /favorite|like|engagement|retweet/i.test(h)) ||
        allHeaders[1];

      if (!textCol || !metricCol)
        return { error: 'Could not detect text or metric columns. Please specify them.' };

      const colMean = (subset) => {
        const vals = subset.map((r) => parseFloat(r[metricCol])).filter((v) => !isNaN(v));
        return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : 0;
      };

      const chartData = keywords.map((kw) => {
        const lower = kw.toLowerCase();
        const withKw = rows.filter((r) =>
          String(r[textCol] || '').toLowerCase().includes(lower)
        );
        const withoutKw = rows.filter(
          (r) => !String(r[textCol] || '').toLowerCase().includes(lower)
        );
        return {
          name: kw,
          withKeyword: colMean(withKw),
          withoutKeyword: colMean(withoutKw),
          withCount: withKw.length,
          withoutCount: withoutKw.length,
        };
      });

      // Return a special chart payload — Chat.js will render the EngagementChart component
      return {
        _chartType: 'engagement',
        metricColumn: metricCol,
        textColumn: textCol,
        data: chartData,
        summary: chartData
          .map(
            (d) =>
              `${d.name}: with=${d.withKeyword} (n=${d.withCount}), without=${d.withoutKeyword} (n=${d.withoutCount})`
          )
          .join('; '),
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
};
