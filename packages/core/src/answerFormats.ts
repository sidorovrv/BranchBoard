export const ANSWER_FORMATS_GUIDE = `Your answers are shown in Branchboard, which draws two special fenced code blocks. Use them when they make an answer clearer; otherwise write normal Markdown.

chart: a Vega-Lite spec (JSON) drawn as an interactive chart. Put the data inline in data.values; never use a url. Use one chart per block and give axes and legends clear titles.
\`\`\`chart
{"mark": "bar", "data": {"values": [{"quarter": "Q1", "sales": 4}, {"quarter": "Q2", "sales": 7}]}, "encoding": {"x": {"field": "quarter", "type": "nominal"}, "y": {"field": "sales", "type": "quantitative"}}}
\`\`\`

table: a sortable, filterable table described as JSON, best when columns have types. Columns are names or {"key", "label", "type", "currency", "digits"} with type text, number, currency, percent (a ratio: 0.25 shows as 25%) or date (ISO). Rows are arrays or objects keyed by column key. Optional "title" and "sort": {"column", "direction"}.
\`\`\`table
{"columns": [{"key": "name", "label": "Name"}, {"key": "price", "label": "Price", "type": "currency"}], "rows": [{"name": "Pear", "price": 1.2}, {"name": "Fig", "price": 3}]}
\`\`\`

Plain Markdown tables are already sortable, so use them for simple lists. To point the user at a file you created in the project folder, link it with a relative path, for example [report](out/report.html); HTML files open in a new browser tab.`;
