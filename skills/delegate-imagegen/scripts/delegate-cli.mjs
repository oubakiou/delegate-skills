import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
//#region node_modules/md2idx/dist/md2idx.mjs
var INACTIVE_FENCE = {
	active: false,
	char: "",
	len: 0
};
var NO_PARAGRAPH = -1;
var stripInlineMarkup = (text) => text.replace(/!\[(?<text>[^\]]*)\]\([^)]*\)/g, "$<text>").replace(/\[(?<text>[^\]]*)\]\([^)]*\)/g, "$<text>").replace(/\[(?<text>[^\]]*)\]\[[^\]]*\]/g, "$<text>").replace(/``(?<text>[^`]*)``/g, "$<text>").replace(/`(?<text>[^`]*)`/g, "$<text>").replace(/\*{1,3}(?<text>[^*]+)\*{1,3}/g, "$<text>").replace(/_{1,3}(?<text>[^_]+)_{1,3}/g, "$<text>").replace(/~~(?<text>[^~]+)~~/g, "$<text>");
var stripAtxTrailing = (line) => line.replace(/\s+#+\s*$/, "");
var FENCE_RE = /^ {0,3}(?<marker>`{3,}|~{3,})/;
var ATX_RE = /^ {0,3}(?<hashes>#{1,6})\s/;
var updateFenceState = (line, fence) => {
	const opening = FENCE_RE.exec(line);
	if (!opening) return fence;
	if (!fence.active) return {
		active: true,
		char: opening[1][0],
		len: opening[1].length
	};
	const closing = /^ {0,3}(?<marker>`{3,}|~{3,})\s*$/.exec(line);
	if (closing && line.trimStart().startsWith(fence.char) && closing[1].length >= fence.len) return INACTIVE_FENCE;
	return fence;
};
var tryAtxHeading = (line, offset) => {
	const match = ATX_RE.exec(line);
	if (!match) return null;
	return {
		depth: match[1].length,
		offset,
		text: stripInlineMarkup(stripAtxTrailing(line.slice(match[0].length)).trim())
	};
};
var isSetextH1 = (line) => /^ {0,3}={1,}\s*$/.test(line);
var isSetextH2 = (line) => /^ {0,3}-{2,}\s*$/.test(line);
var setextDepth = (line) => {
	if (isSetextH1(line)) return 1;
	if (isSetextH2(line)) return 2;
	return null;
};
var trySetextFromState = (state, line, markdown) => {
	if (state.paragraphStartOffset === NO_PARAGRAPH || state.prevWasFenceBoundary) return null;
	const depth = setextDepth(line);
	if (depth === null) return null;
	const text = stripInlineMarkup(markdown.slice(state.paragraphStartOffset, state.offset).trimEnd().split("\n").map((pl) => pl.trim()).join(" "));
	return {
		depth,
		offset: state.paragraphStartOffset,
		text
	};
};
var resetState = (ctx, wasFenceBoundary) => ({
	fence: ctx.fence,
	offset: ctx.nextOffset,
	paragraphStartOffset: NO_PARAGRAPH,
	prevWasFenceBoundary: wasFenceBoundary
});
var paragraphStart = (state) => {
	if (state.paragraphStartOffset === NO_PARAGRAPH) return state.offset;
	return state.paragraphStartOffset;
};
var extendParagraph = (state, ctx) => ({
	fence: ctx.fence,
	offset: ctx.nextOffset,
	paragraphStartOffset: paragraphStart(state),
	prevWasFenceBoundary: false
});
var isIndentedCode = (line) => /^ {4,}\S/.test(line);
var isBlockStart = (line) => /^ {0,3}(?:[-*+]|\d{1,9}[.)]) /.test(line) || line.trimStart().startsWith(">");
var findHeading = (state, line, markdown) => tryAtxHeading(line, state.offset) ?? trySetextFromState(state, line, markdown);
var processLine = (state, line, ctx) => {
	if (ctx.fence.active || ctx.fence !== state.fence) return resetState(ctx, true);
	if (!line.trim() || isIndentedCode(line) || isBlockStart(line)) return resetState(ctx, false);
	const heading = findHeading(state, line, ctx.markdown);
	if (heading) {
		ctx.headings.push(heading);
		return resetState(ctx, false);
	}
	return extendParagraph(state, ctx);
};
var parseHeadings = (markdown) => {
	const lines = markdown.split("\n");
	const headings = [];
	const initial = {
		fence: INACTIVE_FENCE,
		offset: 0,
		paragraphStartOffset: NO_PARAGRAPH,
		prevWasFenceBoundary: false
	};
	lines.reduce((state, line) => {
		return processLine(state, line, {
			fence: updateFenceState(line, state.fence),
			headings,
			markdown,
			nextOffset: state.offset + line.length + 1
		});
	}, initial);
	return headings;
};
var getFirstOffset = (headings, markdownLength) => {
	if (headings.length > 0) return headings[0].offset;
	return markdownLength;
};
var getSectionEnd = (headings, idx, markdownLength) => {
	const next = headings[idx + 1];
	if (next) return next.offset;
	return markdownLength;
};
var buildPreamble = (markdown, firstOffset) => {
	if (firstOffset <= 0) return {
		indexLines: [],
		sections: []
	};
	const preamble = markdown.slice(0, firstOffset).trimEnd();
	if (!preamble) return {
		indexLines: [],
		sections: []
	};
	return {
		indexLines: ["0."],
		sections: [preamble]
	};
};
var normalizeCrlf = (text) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
var md2idx = (markdown) => {
	const normalized = normalizeCrlf(markdown);
	const headings = parseHeadings(normalized);
	const preamble = buildPreamble(normalized, getFirstOffset(headings, normalized.length));
	const headingSections = headings.map((heading, idx) => {
		const end = getSectionEnd(headings, idx, normalized.length);
		return normalized.slice(heading.offset, end).trimEnd();
	});
	const headingIndex = headings.map((heading, idx) => {
		return `${"#".repeat(heading.depth)} ${idx + preamble.sections.length}. ${heading.text}`;
	});
	return {
		index: [...preamble.indexLines, ...headingIndex].join("\n"),
		sections: [...preamble.sections, ...headingSections]
	};
};
//#endregion
//#region shared/src/protocol.ts
var utf8SequenceLength = (lead) => {
	if (lead < 128) return 1;
	if (lead >= 194 && lead <= 223) return 2;
	if (lead >= 224 && lead <= 239) return 3;
	if (lead >= 240 && lead <= 244) return 4;
	return 0;
};
var isValidUtf8Sequence = (body, offset, length) => {
	if (offset + length > body.length) return false;
	for (let position = offset + 1; position < offset + length; position += 1) {
		const byte = body[position];
		if (byte < 128 || byte > 191) return false;
	}
	return true;
};
var wcCharCount = (body) => {
	let count = 0;
	let offset = 0;
	while (offset < body.length) {
		const length = utf8SequenceLength(body[offset]);
		if (length > 0 && isValidUtf8Sequence(body, offset, length)) {
			count += 1;
			offset += length;
		} else offset += 1;
	}
	return count;
};
var bodyStats = (body) => ({
	bytes: body.length,
	chars: wcCharCount(body),
	lines: body.filter((byte) => byte === 10).length
});
var estimatedTokens = (chars) => Math.floor((chars + 3) / 4);
var prettyJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
var metricsTimestamp = () => {
	return `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19)}Z`;
};
var appendMetrics = (metricsFile, record) => {
	if (typeof metricsFile !== "string" || metricsFile === "") return;
	try {
		mkdirSync(path.dirname(metricsFile), { recursive: true });
		appendFileSync(metricsFile, `${JSON.stringify(record)}\n`);
	} catch {}
};
var writeCompanionMarkdown = (jsonFile, sections) => {
	try {
		writeFileSync(`${jsonFile.replace(/\.json$/, "")}.md`, `${sections.join("\n\n")}\n`);
	} catch {}
};
var TOKEN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
var randomToken = (length) => {
	let token = "";
	for (let position = 0; position < length; position += 1) token += TOKEN_CHARS[Math.floor(Math.random() * 62)];
	return token;
};
var pad = (value) => String(value).padStart(2, "0");
var runTimestamp = () => {
	const now = /* @__PURE__ */ new Date();
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};
var sectionBanner = (sections) => sections.map((value, key) => `===== section[${key}] =====\n${value}`).join("\n");
var stripTrailingNewlines = (value) => value.replace(/\n+$/, "");
var emitForMetrics = (raw, metricsEnabled) => {
	if (!metricsEnabled) return {
		measured: `${raw}\n`,
		stdout: `${raw}\n`
	};
	const stripped = stripTrailingNewlines(raw);
	return {
		measured: `${stripped}\n`,
		stdout: `${stripped}\n`
	};
};
var selectedStats = (measured) => bodyStats(Buffer.from(measured));
//#endregion
//#region shared/src/build-request.ts
var failure$4 = (exitCode, stderr) => ({
	exitCode,
	stderr,
	stdout: ""
});
var positiveIntOrZero = (value) => {
	if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return 0;
	return Number(value);
};
var observePhase = (observeFile) => {
	try {
		const parsed = JSON.parse(readFileSync(observeFile, "utf8"));
		if (typeof parsed === "object" && parsed !== null && "state" in parsed) {
			const { state } = parsed;
			if (typeof state === "object" && state !== null && "phase" in state) {
				const { phase } = state;
				if (typeof phase === "string") return phase;
			}
		}
	} catch {}
	return "";
};
var removeRunDirIfExpired = (candidate, cutoffMs) => {
	try {
		const stat = statSync(candidate);
		if (stat.isDirectory() && Date.now() - stat.mtimeMs >= cutoffMs && observePhase(`${candidate}_observe.json`) !== "running") rmSync(candidate, {
			force: true,
			recursive: true
		});
	} catch {}
};
var cleanupOldRunDirs = (workDir, env) => {
	const retentionDays = positiveIntOrZero(env.DELEGATE_RUN_RETENTION_DAYS);
	if (retentionDays <= 0) return;
	const cutoffMs = (retentionDays + 1) * 24 * 60 * 60 * 1e3;
	let entries = [];
	try {
		entries = readdirSync(workDir);
	} catch {
		return;
	}
	for (const name of entries.filter((entry) => entry.startsWith("delegate_"))) removeRunDirIfExpired(path.join(workDir, name), cutoffMs);
};
var isCollision = (error) => typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
var tryAllocateRunPaths = (workDir, taskType, timestamp) => {
	const token = randomToken(5);
	const requestFile = path.join(workDir, `delegate_${taskType}_${timestamp}_${token}_req.json`);
	try {
		closeSync(openSync(requestFile, "wx"));
	} catch (error) {
		if (isCollision(error)) return failure$4(0, "");
		return failure$4(1, `ERROR: request_file を作成できません: ${requestFile}\n`);
	}
	const base = requestFile.replace(/_req\.json$/, "");
	return {
		requestFile,
		responseFile: `${base}_res.json`,
		runDir: base,
		observeFile: `${base}_observe.json`
	};
};
var MAX_ALLOCATE_ATTEMPTS = 100;
var allocateRunPaths = (workDir, taskType) => {
	const timestamp = runTimestamp();
	for (let attempt = 0; attempt < MAX_ALLOCATE_ATTEMPTS; attempt += 1) {
		const paths = tryAllocateRunPaths(workDir, taskType, timestamp);
		if ("requestFile" in paths || paths.exitCode !== 0) return paths;
	}
	return failure$4(1, `ERROR: request_file の名前衝突が解消できません: ${workDir}\n`);
};
var parseChainArg = (raw) => {
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed;
	} catch {}
	return null;
};
var writeSourceMarkdown$1 = (workDir, runDir, stdin) => {
	const srcMd = path.join(workDir, `${path.basename(runDir)}_reqsrc_${randomToken(5)}.md`);
	const fd = openSync(srcMd, "wx");
	writeSync(fd, stdin);
	closeSync(fd);
	return srcMd;
};
var appendBuildRequestMetrics = (context, sectionCount) => {
	const body = bodyStats(context.stdin);
	appendMetrics(context.env.DELEGATE_METRICS_FILE, {
		kind: "build_request",
		ts: metricsTimestamp(),
		task_type: context.taskType,
		model: context.model,
		requester_session_id: context.requesterSessionId,
		request_file: context.paths.requestFile,
		response_file: context.paths.responseFile,
		body: {
			bytes: body.bytes,
			chars: body.chars,
			lines: body.lines,
			estimated_tokens: estimatedTokens(body.chars)
		},
		request: {
			bytes: statSync(context.paths.requestFile).size,
			sections: sectionCount
		}
	});
};
var emitRequest = (context) => {
	const { paths } = context;
	const srcMd = writeSourceMarkdown$1(context.workDir, paths.runDir, context.stdin);
	const { index, sections } = md2idx(context.stdin.toString("utf8"));
	writeFileSync(paths.requestFile, prettyJson({
		protocol_version: 1,
		type: "request",
		task_type: context.taskType,
		model: context.model,
		task_type_chain: context.taskTypeChain,
		requester_session_id: context.requesterSessionId,
		index,
		sections
	}));
	if (index.length === 0 || sections.length === 0) return failure$4(1, `ERROR: md2idx が空の index/sections を返しました（入力 Markdown を確認してください）: ${srcMd}\n`);
	writeCompanionMarkdown(paths.requestFile, sections);
	unlinkSync(srcMd);
	appendBuildRequestMetrics(context, sections.length);
	return {
		exitCode: 0,
		stderr: "",
		stdout: prettyJson({
			request_file: paths.requestFile,
			response_file: paths.responseFile,
			run_dir: paths.runDir,
			observe_file: paths.observeFile
		})
	};
};
var nonEmptyEnv = (value) => {
	if (typeof value === "string" && value !== "") return value;
	return null;
};
var prepareWorkDir = (env) => {
	const workDir = path.resolve(nonEmptyEnv(env.DELEGATE_WORK_DIR) ?? nonEmptyEnv(env.TMPDIR) ?? "/tmp");
	mkdirSync(workDir, { recursive: true });
	cleanupOldRunDirs(workDir, env);
	return workDir;
};
var prepareRunPaths = (env, taskType) => {
	const workDir = prepareWorkDir(env);
	const paths = allocateRunPaths(workDir, taskType);
	if (!("requestFile" in paths)) return paths;
	mkdirSync(paths.runDir, { recursive: true });
	return {
		workDir,
		paths
	};
};
var runBuildRequest = (argv, env, stdin) => {
	if (argv.length < 4) return failure$4(2, "Usage: build-request <task_type> <model> <task_type_chain_json> <requester_session_id>  (request body markdown on stdin)\n");
	const [taskType, model, taskTypeChainRaw, requesterSessionId] = argv;
	const taskTypeChain = parseChainArg(taskTypeChainRaw);
	if (taskTypeChain === null) return failure$4(2, `ERROR: task_type_chain が JSON 配列ではありません: ${taskTypeChainRaw}\n`);
	const prepared = prepareRunPaths(env, taskType);
	if ("exitCode" in prepared) return prepared;
	return emitRequest({
		taskType,
		model,
		taskTypeChain,
		requesterSessionId,
		env,
		stdin,
		workDir: prepared.workDir,
		paths: prepared.paths
	});
};
//#endregion
//#region shared/src/build-response.ts
var VALID_STATUSES = new Set([
	"completed",
	"partial",
	"failed",
	"needs_input"
]);
var failure$3 = (exitCode, stderr) => ({
	exitCode,
	stderr,
	stdout: ""
});
var writeSourceMarkdown = (context) => {
	const workDir = path.dirname(context.responseFile);
	mkdirSync(workDir, { recursive: true });
	const base = path.basename(context.responseFile, ".json");
	const srcMd = path.join(workDir, `${base}_repsrc_${randomToken(5)}.md`);
	const fd = openSync(srcMd, "wx");
	writeSync(fd, context.stdin);
	closeSync(fd);
	return srcMd;
};
var appendBuildResponseMetrics = (context, sectionCount) => {
	const body = bodyStats(context.stdin);
	appendMetrics(context.env.DELEGATE_METRICS_FILE, {
		kind: "build_response",
		ts: metricsTimestamp(),
		status: context.status,
		responder_session_id: context.responderSessionId,
		response_file: context.responseFile,
		body: {
			bytes: body.bytes,
			chars: body.chars,
			lines: body.lines,
			estimated_tokens: estimatedTokens(body.chars)
		},
		response: {
			bytes: statSync(context.responseFile).size,
			sections: sectionCount
		}
	});
};
var emitResponse = (context) => {
	const srcMd = writeSourceMarkdown(context);
	const { index, sections } = md2idx(context.stdin.toString("utf8"));
	writeFileSync(context.responseFile, prettyJson({
		protocol_version: 1,
		type: "response",
		status: context.status,
		responder_session_id: context.responderSessionId,
		index,
		sections
	}));
	if (index.length === 0 || sections.length === 0) return failure$3(1, `ERROR: md2idx が空の index/sections を返しました（report Markdown を確認してください）: ${srcMd}\n`);
	writeCompanionMarkdown(context.responseFile, sections);
	unlinkSync(srcMd);
	appendBuildResponseMetrics(context, sections.length);
	return {
		exitCode: 0,
		stderr: "",
		stdout: `${context.responseFile}\n`
	};
};
var runBuildResponse = (argv, env, stdin) => {
	if (argv.length < 3) return failure$3(2, "Usage: build-response <status> <responder_session_id> <response_file>  (report markdown on stdin)\n");
	const [status, responderSessionId, responseFile] = argv;
	if (!VALID_STATUSES.has(status)) return failure$3(2, `ERROR: status は completed|partial|failed|needs_input のいずれか: ${status}\n`);
	return emitResponse({
		status,
		responderSessionId,
		responseFile,
		env,
		stdin
	});
};
//#endregion
//#region shared/src/check-delegate-chain.ts
var failure$2 = (exitCode, stderr) => ({
	exitCode,
	stderr,
	stdout: ""
});
var normalizeChain = (rawChain) => {
	if (rawChain === "") return "[]";
	return rawChain;
};
var parseChain = (rawChain) => {
	let parsed = null;
	try {
		parsed = JSON.parse(rawChain);
	} catch {
		return failure$2(5, `ERROR: parent_task_type_chain is not valid JSON: ${rawChain}\n`);
	}
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return failure$2(5, `ERROR: parent_task_type_chain is not a JSON string array: ${rawChain}\n`);
	return parsed.map(String);
};
var runCheckDelegateChain = (argv) => {
	if (argv.length < 2) return failure$2(2, "Usage: check-delegate-chain <task_type> <parent_task_type_chain_json>\n");
	const [taskType, rawChainArg] = argv;
	const rawChain = normalizeChain(rawChainArg);
	const chain = parseChain(rawChain);
	if (!Array.isArray(chain)) return chain;
	if (chain.includes(taskType)) return failure$2(4, `ERROR: 委譲チェーンに '${taskType}' が既に存在します（同一種別の多段委譲は禁止）: ${rawChain}\n`);
	return {
		exitCode: 0,
		stderr: "",
		stdout: `${JSON.stringify([...chain, taskType])}\n`
	};
};
//#endregion
//#region shared/src/read-request.ts
var failure$1 = (exitCode, stderr) => ({
	exitCode,
	stderr,
	stdout: ""
});
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var readJson = (file) => {
	try {
		return {
			ok: true,
			value: JSON.parse(readFileSync(file, "utf8"))
		};
	} catch {
		return {
			ok: false,
			value: null
		};
	}
};
var sectionsOf = (raw) => {
	const value = raw.sections;
	if (Array.isArray(value)) return value.map(String);
	return [];
};
var loadProtocolFile = (file, label) => {
	if (!existsSync(file)) return failure$1(1, `ERROR: ${label} が見つかりません: ${file}\n`);
	const parsed = readJson(file);
	if (!parsed.ok) return failure$1(2, `ERROR: ${label} が JSON として読めません: ${file}\n`);
	if (!isRecord(parsed.value)) return failure$1(2, `ERROR: ${label} が JSON object ではありません: ${file}\n`);
	return {
		raw: parsed.value,
		sections: sectionsOf(parsed.value)
	};
};
var isCliResult = (value) => "exitCode" in value;
var rawStringField = (doc, key) => {
	const value = doc.raw[key];
	if (typeof value === "string") return value;
	return JSON.stringify(value ?? null);
};
var pickMeta = (doc, keys) => {
	const meta = {};
	for (const key of keys) meta[key] = doc.raw[key] ?? null;
	return meta;
};
var sectionAt = (doc, index) => {
	if (index >= 0 && index < doc.sections.length) return doc.sections[index];
	return failure$1(5, `jq: error: section[${index}] は範囲外\n`);
};
var selectorOrDefault = (arg, fallback) => {
	if (typeof arg === "string" && arg !== "") return arg;
	return fallback;
};
var REQUEST_META_KEYS = [
	"protocol_version",
	"type",
	"task_type",
	"model",
	"task_type_chain",
	"requester_session_id"
];
var selectRequestOutput = (doc, selector) => {
	if (selector === "index") return rawStringField(doc, "index");
	if (selector === "meta") return prettyJson(pickMeta(doc, REQUEST_META_KEYS)).replace(/\n$/, "");
	if (selector === "all") return sectionBanner(doc.sections);
	if (/^[0-9]+$/.test(selector)) return sectionAt(doc, Number(selector));
	return failure$1(1, `ERROR: 不明な selector: ${selector}（index|meta|all|<整数N> のいずれか）\n`);
};
var appendReadRequestMetrics = (env, target, measured) => {
	const selected = selectedStats(measured);
	appendMetrics(env.DELEGATE_METRICS_FILE, {
		kind: "read_request",
		ts: metricsTimestamp(),
		selector: target.selector,
		task_type: rawStringField(target.doc, "task_type"),
		request_file: target.requestFile,
		request: {
			bytes: statSync(target.requestFile).size,
			sections: target.doc.sections.length
		},
		selected: {
			bytes: selected.bytes,
			chars: selected.chars,
			lines: selected.lines,
			estimated_tokens: estimatedTokens(selected.chars)
		}
	});
};
var emitRequestOutput = (raw, env, target) => {
	const metricsFile = env.DELEGATE_METRICS_FILE;
	const metricsEnabled = typeof metricsFile === "string" && metricsFile !== "";
	const emitted = emitForMetrics(raw, metricsEnabled);
	if (metricsEnabled) appendReadRequestMetrics(env, target, emitted.measured);
	return {
		exitCode: 0,
		stderr: "",
		stdout: emitted.stdout
	};
};
var selectFromFile = (requestFile, selector) => {
	const doc = loadProtocolFile(requestFile, "request_file");
	if (isCliResult(doc)) return doc;
	const raw = selectRequestOutput(doc, selector);
	if (typeof raw !== "string") return raw;
	return {
		doc,
		raw
	};
};
var runReadRequest = (argv, env) => {
	if (argv.length < 1) return failure$1(2, "Usage: read-request <request_file> [index|meta|all|<N>]\n");
	const [requestFile, selectorArg] = argv;
	const selector = selectorOrDefault(selectorArg, "index");
	const selected = selectFromFile(requestFile, selector);
	if ("exitCode" in selected) return selected;
	return emitRequestOutput(selected.raw, env, {
		requestFile,
		selector,
		doc: selected.doc
	});
};
//#endregion
//#region shared/src/read-response.ts
var failure = (exitCode, stderr) => ({
	exitCode,
	stderr,
	stdout: ""
});
var RESPONSE_META_KEYS = [
	"protocol_version",
	"type",
	"status",
	"responder_session_id"
];
var DEFAULT_INLINE_MAX = 10240;
var entryFor = (doc, name) => {
	const pattern = new RegExp(`^#+\\s*${name}\\s*$`);
	for (const [key, value] of doc.sections.entries()) if (pattern.test(value.split("\n")[0])) return {
		key,
		value
	};
	return null;
};
var clip = (text, cap) => {
	const points = text.match(/./gsu) ?? [];
	if (points.length > cap) return `${points.slice(0, cap).join("")}\n…(truncated。全文は <N> で取得)`;
	return text;
};
var inlineAllOutput = (doc) => `status: ${rawStringField(doc, "status")}\n${sectionBanner(doc.sections)}`;
var largeHeader = (doc) => `status: ${rawStringField(doc, "status")}\n===== index =====\n${rawStringField(doc, "index")}\n`;
var autoLargeOutput = (doc) => {
	const summary = entryFor(doc, "Summary");
	if (summary === null) return `${largeHeader(doc)}large response: ${doc.sections.length} sections（Summary section 無し。必要 section のみ <N> で取得）`;
	return `${largeHeader(doc)}===== section[${summary.key}] (Summary) =====\n${summary.value}\n（他 section は必要分のみ <N> で取得）`;
};
var namedSectionBlock = (doc, name, cap) => {
	const entry = entryFor(doc, name);
	if (entry === null) return "";
	let text = entry.value;
	if (cap !== null) text = clip(entry.value, cap);
	return `===== section[${entry.key}] (${name}) =====\n${text}\n`;
};
var decisionLargeOutput = (doc, cap) => `${largeHeader(doc)}${namedSectionBlock(doc, "Summary", null)}${namedSectionBlock(doc, "Findings", cap)}${namedSectionBlock(doc, "Blockers", cap)}（他 section は必要分のみ <N> で取得）`;
var parseThreshold = (env) => {
	const rawValue = env.DELEGATE_RESPONSE_INLINE_MAX;
	if (typeof rawValue !== "string" || rawValue === "") return DEFAULT_INLINE_MAX;
	if (!/^[0-9]+$/.test(rawValue)) return failure(2, `ERROR: DELEGATE_RESPONSE_INLINE_MAX が整数ではありません: ${rawValue}\n`);
	return Number(rawValue);
};
var gatedOutput = (doc, target, env) => {
	const threshold = parseThreshold(env);
	if (typeof threshold !== "number") return threshold;
	const { size } = statSync(target.responseFile);
	if (size < threshold) return {
		raw: inlineAllOutput(doc),
		inline: true,
		threshold
	};
	if (target.selector === "decision") return {
		raw: decisionLargeOutput(doc, threshold),
		inline: false,
		threshold
	};
	return {
		raw: autoLargeOutput(doc),
		inline: false,
		threshold
	};
};
var fixedSelectorOutcome = (doc, selector) => {
	switch (selector) {
		case "status": return {
			raw: rawStringField(doc, "status"),
			inline: false,
			threshold: 0
		};
		case "index": return {
			raw: rawStringField(doc, "index"),
			inline: false,
			threshold: 0
		};
		case "meta": return {
			raw: prettyJson(pickMeta(doc, RESPONSE_META_KEYS)).replace(/\n$/, ""),
			inline: false,
			threshold: 0
		};
		case "all": return {
			raw: sectionBanner(doc.sections),
			inline: true,
			threshold: 0
		};
		default: return null;
	}
};
var numericOutcome = (doc, selector) => {
	const section = sectionAt(doc, Number(selector));
	if (typeof section !== "string") return section;
	return {
		raw: section,
		inline: true,
		threshold: 0
	};
};
var plainOutput = (doc, selector) => {
	const fixed = fixedSelectorOutcome(doc, selector);
	if (fixed !== null) return fixed;
	if (/^[0-9]+$/.test(selector)) return numericOutcome(doc, selector);
	return failure(1, `ERROR: 不明な selector: ${selector}（status|auto|decision|index|meta|all|<整数N> のいずれか）\n`);
};
var selectResponseOutput = (doc, target, env) => {
	if (target.selector === "auto" || target.selector === "decision") return gatedOutput(doc, target, env);
	return plainOutput(doc, target.selector);
};
var appendReadResponseMetrics = (env, input, measured) => {
	const selected = selectedStats(measured);
	const responseBytes = statSync(input.responseFile).size;
	appendMetrics(env.DELEGATE_METRICS_FILE, {
		kind: "read_response",
		ts: metricsTimestamp(),
		duration_ms: input.durationMs,
		selector: input.selector,
		status: rawStringField(input.doc, "status"),
		response_file: input.responseFile,
		inline: input.outcome.inline,
		threshold: input.outcome.threshold,
		response: {
			bytes: responseBytes,
			sections: input.doc.sections.length,
			estimated_tokens: estimatedTokens(responseBytes)
		},
		selected: {
			bytes: selected.bytes,
			chars: selected.chars,
			lines: selected.lines,
			estimated_tokens: estimatedTokens(selected.chars)
		}
	});
};
var emitResponseOutput = (env, input) => {
	const metricsFile = env.DELEGATE_METRICS_FILE;
	const metricsEnabled = typeof metricsFile === "string" && metricsFile !== "";
	const emitted = emitForMetrics(input.outcome.raw, metricsEnabled);
	if (metricsEnabled) appendReadResponseMetrics(env, input, emitted.measured);
	return {
		exitCode: 0,
		stderr: "",
		stdout: emitted.stdout
	};
};
var resolveOutcome = (target, env) => {
	const doc = loadProtocolFile(target.responseFile, "response_file");
	if (isCliResult(doc)) return doc;
	const outcome = selectResponseOutput(doc, target, env);
	if ("exitCode" in outcome) return outcome;
	return {
		doc,
		outcome
	};
};
var runReadResponse = (argv, env) => {
	const startedAt = performance.now();
	if (argv.length < 1) return failure(2, "Usage: read-response <response_file> [status|auto|decision|index|meta|all|<N>]\n");
	const [responseFile, selectorArg] = argv;
	const selector = selectorOrDefault(selectorArg, "status");
	const resolved = resolveOutcome({
		responseFile,
		selector
	}, env);
	if ("exitCode" in resolved) return resolved;
	return emitResponseOutput(env, {
		responseFile,
		selector,
		doc: resolved.doc,
		outcome: resolved.outcome,
		durationMs: Math.round(performance.now() - startedAt)
	});
};
//#endregion
//#region shared/src/resolve-model.ts
var nonEmptyEnvValue = (value) => {
	if (typeof value === "string" && value !== "") return value;
	return null;
};
var runResolveModel = (argv, env) => {
	if (argv.length < 2) return {
		exitCode: 2,
		stderr: "Usage: resolve-model <TYPE_ENV_NAME> <DEFAULT_MODEL>\n",
		stdout: ""
	};
	const [typeEnvName, defaultModel] = argv;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(typeEnvName)) return {
		exitCode: 1,
		stderr: `ERROR: invalid environment variable name: ${typeEnvName}\n`,
		stdout: ""
	};
	return {
		exitCode: 0,
		stderr: "",
		stdout: `${nonEmptyEnvValue(env[typeEnvName] ?? null) ?? defaultModel}\n`
	};
};
//#endregion
//#region shared/src/main.ts
var CLI_VERSION = "0.0.0-dev";
var versionResult = () => ({
	exitCode: 0,
	stderr: "",
	stdout: `delegate-cli ${CLI_VERSION}\n`
});
var md2idxSmokeResult = () => {
	const { index, sections } = md2idx("# smoke\n\nbody\n\n## child\n\nbody2\n");
	return {
		exitCode: 0,
		stderr: "",
		stdout: `${JSON.stringify({
			index,
			section_count: sections.length
		})}\n`
	};
};
var STDIN_SUBCOMMANDS = new Set(["build-request", "build-response"]);
var HANDLERS = {
	"--version": () => versionResult(),
	version: () => versionResult(),
	"md2idx-smoke": () => md2idxSmokeResult(),
	"resolve-model": (rest) => runResolveModel(rest, process.env),
	"check-delegate-chain": (rest) => runCheckDelegateChain(rest),
	"build-request": (rest, stdin) => runBuildRequest(rest, process.env, stdin),
	"read-request": (rest) => runReadRequest(rest, process.env),
	"build-response": (rest, stdin) => runBuildResponse(rest, process.env, stdin),
	"read-response": (rest) => runReadResponse(rest, process.env)
};
var runCli = (argv, stdin = Buffer.alloc(0)) => {
	if (argv.length === 0) return {
		exitCode: 2,
		stderr: "delegate-cli: missing subcommand (try --version)\n",
		stdout: ""
	};
	const [subcommand, ...rest] = argv;
	const handler = HANDLERS[subcommand];
	if (typeof handler !== "function") return {
		exitCode: 2,
		stderr: `delegate-cli: unknown subcommand: ${subcommand}\n`,
		stdout: ""
	};
	return handler(rest, stdin);
};
{
	const argv = process.argv.slice(2);
	let stdin = Buffer.alloc(0);
	if (typeof argv[0] === "string" && STDIN_SUBCOMMANDS.has(argv[0])) stdin = readFileSync(0);
	const result = runCli(argv, stdin);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.exitCode;
}
//#endregion
export { CLI_VERSION, runCli };
