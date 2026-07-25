(function exposeBookImporter() {
  const HEADER_ALIASES = {
    sequence: ["序号", "编号", "id", "number", "no", "index"],
    word: ["单词", "词汇", "英文", "word", "vocabulary", "term", "headword"],
    pos: ["词性", "pos", "partofspeech"],
    en: ["英文释义", "英文解释", "englishdefinition", "definition", "meaning"],
    cn: ["中文释义", "中文解释", "中文", "chinesedefinition", "translation"],
    example: ["例句", "英文例句", "example", "examplesentence", "sentence"],
  };

  function normalizedHeader(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_\-—–（）()：:]/g, "");
  }

  function columnIndex(reference) {
    const letters = String(reference || "").match(/[A-Z]+/i)?.[0] || "A";
    let value = 0;
    for (const letter of letters.toUpperCase()) value = value * 26 + letter.charCodeAt(0) - 64;
    return value - 1;
  }

  function textFromNode(node) {
    return Array.from(node.getElementsByTagName("t"))
      .map((item) => item.textContent || "")
      .join("");
  }

  function relationshipPath(target) {
    if (target.startsWith("/")) return target.slice(1);
    return `xl/${target.replace(/^\.\//, "")}`;
  }

  async function xlsxSheets(file) {
    if (!window.JSZip) throw new Error("Excel 读取组件未加载。");
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const parser = new DOMParser();
    const xml = async (path) => {
      const entry = zip.file(path);
      if (!entry) throw new Error(`Excel 文件缺少 ${path}`);
      return parser.parseFromString(await entry.async("string"), "application/xml");
    };
    const workbook = await xml("xl/workbook.xml");
    const relationships = await xml("xl/_rels/workbook.xml.rels");
    const relMap = new Map(
      Array.from(relationships.getElementsByTagName("Relationship")).map((rel) => [
        rel.getAttribute("Id"),
        relationshipPath(rel.getAttribute("Target") || ""),
      ]),
    );
    let sharedStrings = [];
    if (zip.file("xl/sharedStrings.xml")) {
      const shared = await xml("xl/sharedStrings.xml");
      sharedStrings = Array.from(shared.getElementsByTagName("si")).map(textFromNode);
    }
    const sheets = [];
    for (const sheet of Array.from(workbook.getElementsByTagName("sheet"))) {
      const relationshipId =
        sheet.getAttribute("r:id") ||
        sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const path = relMap.get(relationshipId);
      if (!path || !zip.file(path)) continue;
      const document = await xml(path);
      const rows = Array.from(document.getElementsByTagName("row")).map((row) => {
        const result = [];
        for (const cell of Array.from(row.getElementsByTagName("c"))) {
          const index = columnIndex(cell.getAttribute("r"));
          const type = cell.getAttribute("t");
          const valueNode = cell.getElementsByTagName("v")[0];
          let value = "";
          if (type === "s") value = sharedStrings[Number(valueNode?.textContent || 0)] || "";
          else if (type === "inlineStr") value = textFromNode(cell);
          else value = valueNode?.textContent || "";
          result[index] = value;
        }
        return result;
      });
      sheets.push({ name: sheet.getAttribute("name") || "Sheet", rows });
    }
    return sheets;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted && character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (!quoted && character === ",") {
        row.push(value);
        value = "";
      } else if (!quoted && (character === "\n" || character === "\r")) {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        row.push(value);
        if (row.some((cell) => String(cell).trim())) rows.push(row);
        row = [];
        value = "";
      } else {
        value += character;
      }
    }
    row.push(value);
    if (row.some((cell) => String(cell).trim())) rows.push(row);
    return rows;
  }

  function splitExample(rawValue) {
    const blocks = String(rawValue || "")
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean);
    const lines = (blocks[0] || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let exampleEn = lines[0] || "";
    const chineseAt = exampleEn.search(/[\u3400-\u9fff]/);
    if (chineseAt >= 0) exampleEn = exampleEn.slice(0, chineseAt).trim();
    return { exampleEn, exampleCn: lines.slice(1).join("\n") };
  }

  function levenshtein(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      let diagonal = previous[0];
      previous[0] = i;
      for (let j = 1; j <= right.length; j += 1) {
        const above = previous[j];
        previous[j] = Math.min(
          previous[j] + 1,
          previous[j - 1] + 1,
          diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
        );
        diagonal = above;
      }
    }
    return previous[right.length];
  }

  function normalize(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .replaceAll("our", "or");
  }

  function targetScore(headword, candidate) {
    const head = normalize(headword);
    const token = normalize(candidate);
    if (!head || !token) return 0;
    if (head === token) return 100;
    const stems = new Set([head]);
    if (head.endsWith("e")) stems.add(head.slice(0, -1));
    if (head.endsWith("y")) {
      stems.add(head.slice(0, -1));
      stems.add(`${head.slice(0, -1)}i`);
    }
    let best = 0;
    for (const stem of stems) {
      if (stem.length >= 3 && token.startsWith(stem)) {
        const extra = token.length - stem.length;
        if (extra >= 0 && extra <= 5) best = Math.max(best, 88 - extra);
      }
    }
    const distance = levenshtein(head, token);
    if (head.length >= 4 && distance <= Math.max(2, Math.floor(head.length * 0.35))) {
      best = Math.max(best, Math.round(72 - (distance / Math.max(head.length, token.length)) * 30));
    }
    return best;
  }

  function findTarget(sentence, headword) {
    const irregularForms = {
      teach: "taught",
      forget: "forgotten",
      sit: "sat",
      break: "broke",
      half: "halves",
      fly: "flew",
      win: "won",
      wolf: "wolves",
    };
    const alternatives = [headword, irregularForms[String(headword).toLowerCase()]].filter(Boolean);
    for (const alternative of alternatives) {
      const escaped = alternative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`(^|[^A-Za-z])(${escaped})(?=$|[^A-Za-z])`, "i").exec(sentence);
      if (match) {
        return {
          value: match[2],
          index: match.index + (match[1]?.length || 0),
          score: alternative === headword ? 100 : 96,
        };
      }
    }
    const candidates = Array.from(sentence.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g))
      .map((match) => ({
        value: match[0],
        index: match.index,
        score: targetScore(headword, match[0]),
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    return candidates[0]?.score >= 58 ? candidates[0] : null;
  }

  function headerMap(row) {
    const result = {};
    row.forEach((value, index) => {
      const header = normalizedHeader(value);
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (aliases.includes(header) && result[field] === undefined) result[field] = index;
      }
    });
    return result;
  }

  function bestTable(sheets) {
    let best = null;
    for (const sheet of sheets) {
      sheet.rows.slice(0, 40).forEach((row, index) => {
        const columns = headerMap(row);
        const score = ["word", "example", "sequence", "en", "cn"].filter(
          (field) => columns[field] !== undefined,
        ).length;
        if (columns.word !== undefined && columns.example !== undefined && (!best || score > best.score)) {
          best = { sheet, headerIndex: index, columns, score };
        }
      });
    }
    if (!best) throw new Error("未找到“单词”和“例句”列，请检查首行列名。");
    return best;
  }

  function itemsFromTable(table) {
    const items = [];
    let skipped = 0;
    for (const row of table.sheet.rows.slice(table.headerIndex + 1)) {
      const word = String(row[table.columns.word] || "").trim();
      const rawExample = row[table.columns.example];
      if (!word || !rawExample) continue;
      const { exampleEn, exampleCn } = splitExample(rawExample);
      const target = findTarget(exampleEn, word);
      if (!target) {
        skipped += 1;
        continue;
      }
      items.push({
        id: items.length + 1,
        sourceIndex: Number(row[table.columns.sequence]) || items.length + 1,
        word,
        pos: String(row[table.columns.pos] || "").trim(),
        cn: String(row[table.columns.cn] || "").trim(),
        en: String(row[table.columns.en] || "").trim(),
        sourceTerm: word,
        exampleEn,
        exampleCn,
        targetForm: target.value,
        targetIndex: target.index,
        targetScore: target.score,
      });
    }
    if (!items.length) throw new Error("没有找到可生成语境填空的词条。");
    return { items, skipped };
  }

  function normalizeJson(data) {
    const source = Array.isArray(data) ? data : data.items || data.words;
    if (!Array.isArray(source)) throw new Error("JSON 中未找到词条数组。");
    const rows = [
      ["序号", "单词", "词性", "英文释义", "中文释义", "例句"],
      ...source.map((item, index) => [
        item.sourceIndex || item.id || index + 1,
        item.word || item.term || item.headword,
        item.pos,
        item.en || item.definition,
        item.cn || item.translation,
        item.exampleEn
          ? `${item.exampleEn}${item.exampleCn ? `\n${item.exampleCn}` : ""}`
          : item.example || item.sentence,
      ]),
    ];
    return [{ name: "JSON", rows }];
  }

  async function importVocabularyBook(file) {
    const extension = file.name.split(".").pop()?.toLowerCase();
    let sheets;
    if (extension === "xlsx") sheets = await xlsxSheets(file);
    else if (extension === "csv") sheets = [{ name: "CSV", rows: parseCsv(await file.text()) }];
    else if (extension === "json") sheets = normalizeJson(JSON.parse(await file.text()));
    else throw new Error("仅支持 .xlsx、.csv 或 .json 文件。");
    const { items, skipped } = itemsFromTable(bestTable(sheets));
    return {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: file.name.replace(/\.(xlsx|csv|json)$/i, ""),
      source: "本机导入",
      count: items.length,
      importedAt: new Date().toISOString(),
      items,
      skipped,
    };
  }

  window.VocabularyBookImporter = { importVocabularyBook };
})();
