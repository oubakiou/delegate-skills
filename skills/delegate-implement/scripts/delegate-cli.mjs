import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
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
var stripTrailingNewlineBytes = (body) => {
	let end = body.length;
	while (end > 0 && body[end - 1] === 10) end -= 1;
	return body.subarray(0, end);
};
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
var failure$6 = (exitCode, stderr) => ({
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
		if (isCollision(error)) return failure$6(0, "");
		return failure$6(1, `ERROR: request_file を作成できません: ${requestFile}\n`);
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
	return failure$6(1, `ERROR: request_file の名前衝突が解消できません: ${workDir}\n`);
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
	if (index.length === 0 || sections.length === 0) return failure$6(1, `ERROR: md2idx が空の index/sections を返しました（入力 Markdown を確認してください）: ${srcMd}\n`);
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
	if (argv.length < 4) return failure$6(2, "Usage: build-request <task_type> <model> <task_type_chain_json> <requester_session_id>  (request body markdown on stdin)\n");
	const [taskType, model, taskTypeChainRaw, requesterSessionId] = argv;
	const taskTypeChain = parseChainArg(taskTypeChainRaw);
	if (taskTypeChain === null) return failure$6(2, `ERROR: task_type_chain が JSON 配列ではありません: ${taskTypeChainRaw}\n`);
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
var failure$5 = (exitCode, stderr) => ({
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
	if (index.length === 0 || sections.length === 0) return failure$5(1, `ERROR: md2idx が空の index/sections を返しました（report Markdown を確認してください）: ${srcMd}\n`);
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
	if (argv.length < 3) return failure$5(2, "Usage: build-response <status> <responder_session_id> <response_file>  (report markdown on stdin)\n");
	const [status, responderSessionId, responseFile] = argv;
	if (!VALID_STATUSES.has(status)) return failure$5(2, `ERROR: status は completed|partial|failed|needs_input のいずれか: ${status}\n`);
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
var failure$4 = (exitCode, stderr) => ({
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
		return failure$4(5, `ERROR: parent_task_type_chain is not valid JSON: ${rawChain}\n`);
	}
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return failure$4(5, `ERROR: parent_task_type_chain is not a JSON string array: ${rawChain}\n`);
	return parsed.map(String);
};
var runCheckDelegateChain = (argv) => {
	if (argv.length < 2) return failure$4(2, "Usage: check-delegate-chain <task_type> <parent_task_type_chain_json>\n");
	const [taskType, rawChainArg] = argv;
	const rawChain = normalizeChain(rawChainArg);
	const chain = parseChain(rawChain);
	if (!Array.isArray(chain)) return chain;
	if (chain.includes(taskType)) return failure$4(4, `ERROR: 委譲チェーンに '${taskType}' が既に存在します（同一種別の多段委譲は禁止）: ${rawChain}\n`);
	return {
		exitCode: 0,
		stderr: "",
		stdout: `${JSON.stringify([...chain, taskType])}\n`
	};
};
//#endregion
//#region shared/src/backend.ts
var backendFromModel = (model) => {
	if (model.startsWith("gpt")) return "codex";
	if (model.startsWith("swe") || model.startsWith("devin-")) return "devin";
	if (model.startsWith("composer") || model.startsWith("cursor-")) return "cursor";
	return "claude";
};
var backendFor = (taskType, model) => {
	if (taskType === "xresearch") return "grok";
	if (taskType === "imagegen") return "codex";
	return backendFromModel(model);
};
//#endregion
//#region shared/src/jq-compat.ts
var isRecord$1 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var jqCoalesce = (...values) => {
	for (const value of values) if (value !== null && value !== false && typeof value !== "undefined") return value;
	return null;
};
var getPath = (value, keys) => {
	let current = value;
	for (const key of keys) {
		if (!isRecord$1(current)) return null;
		current = current[key] ?? null;
	}
	return current;
};
var stringOf = (value) => {
	if (typeof value === "string") return value;
	return "";
};
var hasFileContent = (file) => {
	try {
		return statSync(file).size > 0;
	} catch {
		return false;
	}
};
var readFileOrEmpty = (file) => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
};
//#endregion
//#region shared/src/observe-lock.ts
var observeLockPath = (observeFile, runDir) => path.join(runDir, `${path.basename(observeFile).replace(/\.json$/, "")}.lock`);
var DEFAULT_LOCK_TIMEOUT_SECONDS = 30;
var lockTimeoutSeconds = (env) => {
	const value = env.DELEGATE_OBSERVE_LOCK_TIMEOUT_SECONDS ?? "";
	if (!/^[0-9]+$/.test(value)) return DEFAULT_LOCK_TIMEOUT_SECONDS;
	return Number(value);
};
var sleepMs = (ms) => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
var readlinkOrNull = (target) => {
	try {
		return readlinkSync(target);
	} catch {
		return null;
	}
};
var errorCode = (error) => {
	if (typeof error === "object" && error !== null && "code" in error) {
		const { code } = error;
		if (typeof code === "string") return code;
	}
	return "";
};
var pidAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
};
var lockEntryExists = (target) => {
	try {
		lstatSync(target);
		return true;
	} catch {
		return false;
	}
};
var removeQuietly = (target) => {
	try {
		rmSync(target, { force: true });
	} catch {}
};
var tryCreateLock = (lockPath, owner) => {
	try {
		symlinkSync(owner, lockPath);
		return true;
	} catch {
		return false;
	}
};
var ownerPidAlive = (owner) => {
	const pid = Number(owner.split(" ")[0]);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	return pidAlive(pid);
};
var reapUnderMutex = (lockPath) => {
	const current = readlinkOrNull(lockPath);
	if (current !== null) {
		if (!ownerPidAlive(current)) removeQuietly(lockPath);
	} else if (lockEntryExists(lockPath)) removeQuietly(lockPath);
};
var tryReapStale = (lockPath) => {
	const sampled = readlinkOrNull(lockPath);
	if (sampled !== null && ownerPidAlive(sampled)) return;
	if (sampled === null && !lockEntryExists(lockPath)) return;
	const reapLock = `${lockPath}.reap`;
	if (!tryCreateLock(reapLock, `${process.pid} reap`)) return;
	reapUnderMutex(lockPath);
	removeQuietly(reapLock);
};
var spinForLock = (lockPath, owner, timeoutMs) => {
	const startedAt = Date.now();
	for (;;) {
		if (tryCreateLock(lockPath, owner)) return true;
		tryReapStale(lockPath);
		if (Date.now() - startedAt >= timeoutMs) return false;
		sleepMs(50);
	}
};
var acquireObserveLock = (lockPath, env = process.env) => {
	const token = `${process.pid}-${Math.floor(Math.random() * 1e9)}`;
	if (!spinForLock(lockPath, `${process.pid} ${token}`, lockTimeoutSeconds(env) * 1e3)) throw new Error(`observe lock acquisition timed out: ${lockPath}`);
	return token;
};
var releaseObserveLock = (lockPath, token) => {
	if (readlinkOrNull(lockPath) === `${process.pid} ${token}`) removeQuietly(lockPath);
};
var withObserveLock = (observeFile, runDir, operation) => {
	const lockPath = observeLockPath(observeFile, runDir);
	const token = acquireObserveLock(lockPath);
	try {
		return operation();
	} finally {
		releaseObserveLock(lockPath, token);
	}
};
//#endregion
//#region shared/src/observe-timing.ts
var uptimeToMs = (uptime) => {
	const [secText] = uptime.split(".");
	let frac = "";
	if (uptime.includes(".")) frac = uptime.slice(uptime.indexOf(".") + 1);
	const fracHundredths = `${frac}00`.slice(0, 2);
	return Number(secText) * 1e3 + Number(fracHundredths) * 10;
};
var monotonicMs = () => {
	try {
		const [firstField] = readFileSync("/proc/uptime", "utf8").split(/\s/);
		return uptimeToMs(firstField);
	} catch {
		return null;
	}
};
var elapsedMs = (startMs) => {
	const nowMs = monotonicMs();
	if (startMs === null || nowMs === null) return null;
	return nowMs - startMs;
};
//#endregion
//#region shared/src/observe-store.ts
var utcTimestamp = metricsTimestamp;
var readObserveDoc = (observeFile) => {
	const parsed = JSON.parse(readFileSync(observeFile, "utf8"));
	if (!isRecord$1(parsed)) throw new Error(`observe JSON is not an object: ${observeFile}`);
	return parsed;
};
var writeObserveDoc = (observeFile, runDir, doc) => {
	const base = path.basename(observeFile).replace(/\.json$/, "");
	const tmp = path.join(runDir, `${base}_upd_${randomToken(5)}.json`);
	writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
	renameSync(tmp, observeFile);
};
var updateObserve = (observeFile, runDir, mutate) => {
	withObserveLock(observeFile, runDir, () => {
		const doc = readObserveDoc(observeFile);
		mutate(doc);
		writeObserveDoc(observeFile, runDir, doc);
	});
};
var sectionOf = (doc, key) => {
	const value = doc[key];
	if (isRecord$1(value)) return value;
	const fresh = {};
	doc[key] = fresh;
	return fresh;
};
var eventsOf = (doc) => {
	if (Array.isArray(doc.events)) return doc.events;
	const fresh = [];
	doc.events = fresh;
	return fresh;
};
var stringOrEmpty = (value) => {
	if (typeof value === "string") return value;
	return "";
};
var nullIfEmpty$1 = (value) => {
	if (value === "") return null;
	return value;
};
var initObserve = (input) => {
	const now = utcTimestamp();
	const run = {
		task_type: input.taskType,
		model: input.model,
		backend: input.backend,
		request_file: input.requestFile,
		response_file: input.responseFile,
		run_dir: input.runDir,
		requester_session_id: input.requesterSessionId
	};
	if (typeof input.modelSource === "string" && input.modelSource !== "") run.model_source = input.modelSource;
	const doc = {
		schema_version: 1,
		run,
		state: {
			phase: "prepared",
			dispatcher_pid: null,
			started_at: null,
			ended_at: null,
			exit_code: null,
			duration_ms: null,
			response_present: false
		},
		heartbeat: {
			ts: now,
			backend: input.backend,
			child_pid: null,
			stdout_bytes: 0,
			stderr_bytes: 0,
			last_stream_change_at: now
		},
		events: [{
			kind: "run_created",
			ts: now,
			run_dir: input.runDir,
			request_file: input.requestFile,
			response_file: input.responseFile
		}],
		streams: {
			stdout: {
				bytes: 0,
				truncated: false,
				content: ""
			},
			stderr: {
				bytes: 0,
				truncated: false,
				content: ""
			}
		}
	};
	withObserveLock(input.observeFile, input.runDir, () => {
		const base = path.basename(input.observeFile).replace(/\.json$/, "");
		const tmp = path.join(input.runDir, `${base}_init_${randomToken(5)}.json`);
		writeFileSync(tmp, `${JSON.stringify(doc)}\n`);
		renameSync(tmp, input.observeFile);
	});
};
var appendObserveEvent = (observeFile, runDir, event) => {
	updateObserve(observeFile, runDir, (doc) => {
		eventsOf(doc).push(event);
	});
};
var updateLineage = (observeFile, runDir, lineage) => {
	updateObserve(observeFile, runDir, (doc) => {
		doc.lineage = {
			lineage_id: lineage.lineageId,
			followup_of: nullIfEmpty$1(lineage.followupOf ?? "")
		};
	});
};
var gitOutput = (worktree, args) => execFileSync("git", [
	"-C",
	worktree,
	...args
], { encoding: "utf8" }).trimEnd();
var gitQuietFails = (worktree, args) => {
	try {
		execFileSync("git", [
			"-C",
			worktree,
			...args
		], { stdio: "ignore" });
		return false;
	} catch {
		return true;
	}
};
var gitBranchOrEmpty = (worktree) => {
	try {
		return gitOutput(worktree, ["branch", "--show-current"]);
	} catch {
		return "";
	}
};
var updateRunContext = (observeFile, runDir, roots) => {
	const repoReal = realpathSync(roots.repoRoot);
	const worktreeReal = realpathSync(roots.worktreeRoot);
	const gitHead = gitOutput(worktreeReal, ["rev-parse", "HEAD"]);
	const gitBranch = gitBranchOrEmpty(worktreeReal);
	const dirty = gitQuietFails(worktreeReal, [
		"diff",
		"--quiet",
		"--ignore-submodules",
		"--"
	]) || gitQuietFails(worktreeReal, [
		"diff",
		"--cached",
		"--quiet",
		"--ignore-submodules",
		"--"
	]);
	updateObserve(observeFile, runDir, (doc) => {
		doc.run_context = {
			repo_root: repoReal,
			worktree_root: worktreeReal,
			git_head: gitHead,
			git_branch: nullIfEmpty$1(gitBranch),
			dirty
		};
	});
};
var markSuperseded = (observeFile, requester, supersededBy) => {
	const runDir = observeFile.replace(/_observe\.json$/, "");
	if (!existsSync(runDir)) return;
	updateObserve(observeFile, runDir, (doc) => {
		if (getPath(doc, ["state", "phase"]) !== "prepared") return;
		if ((getPath(doc, ["run", "requester_session_id"]) ?? "") !== requester) return;
		sectionOf(doc, "state").phase = "superseded";
		eventsOf(doc).push({
			kind: "superseded",
			ts: utcTimestamp(),
			superseded_by: supersededBy
		});
	});
};
var mtimeOrNull = (file) => {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return null;
	}
};
var requesterOf = (observeFile) => {
	try {
		return stringOrEmpty(getPath(readObserveDoc(observeFile), ["run", "requester_session_id"]));
	} catch {
		return "";
	}
};
var markSuersededQuietly = (candidate, requester, currentBase) => {
	try {
		markSuperseded(candidate, requester, currentBase);
	} catch {}
};
var supersedeStalePrepared = (observeFile, taskType) => {
	const workDir = path.dirname(observeFile);
	const currentBase = path.basename(observeFile);
	const requester = requesterOf(observeFile);
	const currentMtime = mtimeOrNull(observeFile);
	for (const name of readdirSync(workDir)) {
		const candidateMtime = mtimeOrNull(path.join(workDir, name));
		if (name.startsWith(`delegate_${taskType}_`) && name.endsWith("_observe.json") && name !== currentBase && candidateMtime !== null && currentMtime !== null && candidateMtime < currentMtime) markSuersededQuietly(path.join(workDir, name), requester, currentBase);
	}
};
var dispatchStart = (observeFile, runDir, detail) => {
	const now = utcTimestamp();
	updateObserve(observeFile, runDir, (doc) => {
		Object.assign(sectionOf(doc, "state"), {
			phase: "running",
			dispatcher_pid: detail.dispatcherPid,
			started_at: now,
			ended_at: null,
			exit_code: null,
			duration_ms: null,
			response_present: false
		});
		const heartbeatDoc = sectionOf(doc, "heartbeat");
		Object.assign(heartbeatDoc, {
			ts: now,
			backend: detail.backend,
			child_pid: null,
			last_stream_change_at: jqCoalesce(heartbeatDoc.last_stream_change_at) ?? now
		});
		eventsOf(doc).push({
			kind: "dispatch_start",
			ts: now,
			backend: detail.backend,
			dispatcher_pid: detail.dispatcherPid
		});
	});
};
var epochSeconds = (timestamp) => {
	if (timestamp === "") return 0;
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return 0;
	return Math.floor(parsed / 1e3);
};
var dispatchEnd = (observeFile, runDir, detail) => {
	const endedAt = utcTimestamp();
	updateObserve(observeFile, runDir, (doc) => {
		const state = sectionOf(doc, "state");
		const startedAt = stringOrEmpty(jqCoalesce(state.started_at));
		let durationMs = 0;
		if (startedAt !== "") durationMs = (epochSeconds(endedAt) - epochSeconds(startedAt)) * 1e3;
		if (state.phase !== "stalled") state.phase = "ended";
		Object.assign(state, {
			dispatcher_pid: detail.dispatcherPid,
			ended_at: endedAt,
			exit_code: detail.exitCode,
			duration_ms: durationMs,
			response_present: detail.responsePresent
		});
		Object.assign(sectionOf(doc, "heartbeat"), {
			ts: endedAt,
			backend: detail.backend
		});
		eventsOf(doc).push({
			kind: "dispatch_end",
			ts: endedAt,
			backend: detail.backend,
			dispatcher_pid: detail.dispatcherPid,
			exit_code: detail.exitCode
		});
	});
};
var responseMissing = (observeFile, runDir) => {
	appendObserveEvent(observeFile, runDir, {
		kind: "response_missing",
		ts: utcTimestamp()
	});
};
var appendDispatchMetrics = (input, env = process.env) => {
	const metricsFile = env.DELEGATE_METRICS_FILE ?? "";
	if (metricsFile === "") return;
	let timing = {};
	try {
		timing = jqCoalesce(getPath(readObserveDoc(input.observeFile), ["timing"])) ?? {};
	} catch {
		timing = {};
	}
	appendMetrics(metricsFile, {
		kind: "dispatch",
		ts: utcTimestamp(),
		task_type: input.taskType,
		model: input.model,
		backend: input.backend,
		duration_ms: input.durationMs,
		exit_code: input.exitCode,
		response_present: input.responsePresent,
		model_turns: jqCoalesce(getPath(timing, ["model_turns"])),
		tool_calls: jqCoalesce(getPath(timing, ["tool_calls"])),
		time_to_first_useful_event_ms: jqCoalesce(getPath(timing, ["time_to_first_useful_event_ms"])),
		report_ready_at_ms: jqCoalesce(getPath(timing, ["report_ready_at_ms"])),
		structured_output_parse: jqCoalesce(getPath(timing, ["structured_output_parse"])),
		measurement_source: jqCoalesce(getPath(timing, ["measurement_source"])) ?? "unavailable",
		observe_file: input.observeFile,
		response_file: nullIfEmpty$1(input.responseFile ?? "")
	});
};
//#endregion
//#region shared/src/dispatch.ts
var USAGE$2 = "Usage: dispatch <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]\n";
var BACKEND_SCRIPTS = {
	codex: "delegate-codex.sh",
	devin: "delegate-devin.sh",
	cursor: "delegate-cursor.sh"
};
var exitStatusOf = (result) => {
	if (typeof result.status === "number") return result.status;
	if (result.signal !== null) {
		const signum = os.constants.signals[result.signal];
		if (typeof signum === "number") return 128 + signum;
	}
	return 1;
};
var stripTrailingNewlinesText = (value) => value.replace(/\n+$/, "");
var openWrapperCapture = (captureStderr) => {
	const scratch = mkdtempSync(path.join(os.tmpdir(), "delegate-wrapper."));
	const stdoutFile = path.join(scratch, "stdout");
	const stderrFile = path.join(scratch, "stderr");
	const capture = {
		scratch,
		stdoutFile,
		stderrFile,
		stdoutFd: openSync(stdoutFile, "w"),
		stderrFd: null
	};
	if (captureStderr) capture.stderrFd = openSync(stderrFile, "w");
	return capture;
};
var closeQuietly = (fd) => {
	if (fd === null) return;
	try {
		closeSync(fd);
	} catch {}
};
var spawnWrapperCaptured = (input, capture) => {
	const spawned = spawnSync("bash", [input.script, ...input.args], {
		env: { ...input.env },
		stdio: [
			"inherit",
			capture.stdoutFd,
			capture.stderrFd ?? "inherit"
		]
	});
	closeQuietly(capture.stdoutFd);
	closeQuietly(capture.stderrFd);
	const stderrText = (() => {
		if (capture.stderrFd === null) return "";
		return readFileOrEmpty(capture.stderrFile);
	})();
	return {
		exitCode: exitStatusOf(spawned),
		stdout: readFileOrEmpty(capture.stdoutFile),
		stderr: stderrText
	};
};
var spawnWrapper = (input) => {
	const capture = openWrapperCapture(input.captureStderr);
	try {
		return spawnWrapperCaptured(input, capture);
	} finally {
		rmSync(capture.scratch, {
			force: true,
			recursive: true
		});
	}
};
var argOrDefault = (value, fallback) => {
	if (typeof value === "string" && value !== "") return value;
	return fallback;
};
var parseDispatchArgs = (argv) => {
	if (argv.length < 4) return {
		exitCode: 2,
		stderr: USAGE$2,
		stdout: ""
	};
	const [model, taskType, requestFile, responseFile] = argv;
	const runBase = responseFile.replace(/_res\.json$/, "");
	return {
		model,
		taskType,
		requestFile,
		responseFile,
		runDir: argOrDefault(argv[4], runBase),
		observeFile: argOrDefault(argv[5], `${runBase}_observe.json`),
		sessionMode: argv[6] ?? "",
		resumeArg: argv[7] ?? "",
		sessionHome: argv[8] ?? ""
	};
};
var wrapperArgsOf = (args) => {
	const wrapperArgs = [
		args.model,
		args.taskType,
		args.requestFile,
		args.responseFile,
		args.runDir,
		args.observeFile
	];
	if (args.sessionMode !== "" || args.resumeArg !== "" || args.sessionHome !== "") wrapperArgs.push(args.sessionMode, args.resumeArg, args.sessionHome);
	return wrapperArgs;
};
var ensureObserveInitialized = (args, backend) => {
	mkdirSync(args.runDir, { recursive: true });
	if (!hasFileContent(args.observeFile)) initObserve({
		observeFile: args.observeFile,
		runDir: args.runDir,
		taskType: args.taskType,
		model: args.model,
		backend,
		requestFile: args.requestFile,
		responseFile: args.responseFile,
		requesterSessionId: ""
	});
};
var recordDispatchEnd = (env, input) => {
	const { args, backend, outcome } = input;
	const responsePresent = hasFileContent(args.responseFile);
	if (!responsePresent) responseMissing(args.observeFile, args.runDir);
	dispatchEnd(args.observeFile, args.runDir, {
		backend,
		dispatcherPid: process.pid,
		exitCode: outcome.exitCode,
		responsePresent
	});
	try {
		appendDispatchMetrics({
			observeFile: args.observeFile,
			taskType: args.taskType,
			model: args.model,
			backend,
			durationMs: elapsedMs(input.startMs),
			exitCode: outcome.exitCode,
			responsePresent,
			responseFile: args.responseFile
		}, env);
	} catch {}
	return responsePresent;
};
var wrapperStdoutOf = (outcome) => {
	const stripped = stripTrailingNewlinesText(outcome.stdout);
	if (stripped === "") return "";
	return `${stripped}\n`;
};
var startDispatch = (args, backend) => {
	ensureObserveInitialized(args, backend);
	dispatchStart(args.observeFile, args.runDir, {
		backend,
		dispatcherPid: process.pid
	});
	try {
		supersedeStalePrepared(args.observeFile, args.taskType);
	} catch {}
};
var dispatchToWrapper = (args, env, io) => {
	const startMs = monotonicMs();
	const backend = backendFor(args.taskType, args.model);
	if (backend === "grok") return {
		exitCode: 2,
		stderr: "ERROR: grok backend is not supported by shared dispatch.sh; use the xresearch wrapper directly.\n",
		stdout: ""
	};
	startDispatch(args, backend);
	const outcome = spawnWrapper({
		script: path.join(io.scriptsDir, BACKEND_SCRIPTS[backend] ?? "delegate-claude.sh"),
		args: wrapperArgsOf(args),
		env,
		captureStderr: io.captureStderr === true
	});
	recordDispatchEnd(env, {
		args,
		backend,
		startMs,
		outcome
	});
	return {
		exitCode: outcome.exitCode,
		stderr: outcome.stderr,
		stdout: wrapperStdoutOf(outcome)
	};
};
var runDispatch = (argv, env, io) => {
	const args = parseDispatchArgs(argv);
	if ("exitCode" in args) return args;
	return dispatchToWrapper(args, env, io);
};
//#endregion
//#region shared/src/observe-effort.ts
var invalid = (message) => ({
	ok: false,
	message
});
var CLAUDE_EFFORTS = new Set([
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
]);
var CODEX_EFFORTS = new Set([...CLAUDE_EFFORTS, "ultra"]);
var CURSOR_GLM_EFFORTS = new Set(["high", "max"]);
var CURSOR_GROK_EFFORTS = new Set([
	"low",
	"medium",
	"high"
]);
var BACKEND_EFFORT_RULES = {
	claude: {
		allowed: CLAUDE_EFFORTS,
		allowedLabel: "low|medium|high|xhigh|max"
	},
	codex: {
		allowed: CODEX_EFFORTS,
		allowedLabel: "low|medium|high|xhigh|max|ultra"
	}
};
var cursorNamedModelValidation = (cursorModel, model, effort) => {
	if (cursorModel === "glm-5.2") {
		if (CURSOR_GLM_EFFORTS.has(effort)) return { ok: true };
		return invalid(`ERROR: invalid effort '${effort}' for cursor model '${model}'; allowed: high|max`);
	}
	if (cursorModel === "grok-4.5") {
		if (CURSOR_GROK_EFFORTS.has(effort)) return { ok: true };
		return invalid(`ERROR: invalid effort '${effort}' for cursor model '${model}'; allowed: low|medium|high`);
	}
	return null;
};
var validateCursorEffort = (model, base, effort) => {
	let cursorModel = base;
	if (cursorModel.startsWith("cursor-")) cursorModel = cursorModel.slice(7);
	if (cursorModel.endsWith("-high") || cursorModel.endsWith("-max")) return invalid(`ERROR: effort suffix cannot be combined with the effort slug in cursor model '${model}'; use either '${base}' or '${base.slice(0, base.lastIndexOf("-"))}@<effort>'`);
	const named = cursorNamedModelValidation(cursorModel, model, effort);
	if (named !== null) return named;
	return invalid(`ERROR: effort suffix is not supported for cursor model '${model}'; supported: cursor-glm-5.2@(high|max), cursor-grok-4.5@(low|medium|high)`);
};
var validateBackendEffort = (context) => {
	const rule = BACKEND_EFFORT_RULES[context.backend];
	if (typeof rule !== "undefined") {
		if (rule.allowed.has(context.effort)) return { ok: true };
		return invalid(`ERROR: invalid effort '${context.effort}' for ${context.backend} backend model '${context.model}'; allowed: ${rule.allowedLabel}`);
	}
	if (context.backend === "cursor") return validateCursorEffort(context.model, context.base, context.effort);
	return invalid(`ERROR: effort suffix is not supported for the ${context.backend} backend (model '${context.model}'); remove '@${context.effort}'`);
};
var validateModelEffort = (backend, model) => {
	if (!model.includes("@")) return { ok: true };
	const atIndex = model.indexOf("@");
	const base = model.slice(0, atIndex);
	const effort = model.slice(atIndex + 1);
	if (base === "" || effort === "") return invalid(`ERROR: malformed effort suffix in model '${model}'; expected <model>@<effort>`);
	if (effort.includes("@")) return invalid(`ERROR: malformed effort suffix in model '${model}'; expected a single @<effort>`);
	return validateBackendEffort({
		backend,
		model,
		base,
		effort
	});
};
//#endregion
//#region shared/src/observe-followup.ts
var RESUMABLE_BACKENDS = new Set([
	"claude",
	"codex",
	"devin",
	"cursor"
]);
var backendSupportsResume = (backend) => RESUMABLE_BACKENDS.has(backend);
var unavailable = (message) => ({
	ok: false,
	message: `follow-up unavailable: ${message}`
});
var previousSessionOf = (observeFile) => {
	let parsed = null;
	try {
		parsed = JSON.parse(readFileOrEmpty(observeFile));
	} catch {
		return null;
	}
	if (!isRecord$1(parsed)) return null;
	const field = (keys) => {
		const value = getPath(parsed, keys);
		if (typeof value === "string") return value;
		return "";
	};
	return {
		backend: field(["backend_session", "backend"]),
		model: field(["backend_session", "model"]),
		resumeId: field(["backend_session", "resume_id"]),
		persistence: field(["backend_session", "persistence"]),
		repoRoot: field(["run_context", "repo_root"]),
		worktreeRoot: field(["run_context", "worktree_root"]),
		gitHead: field(["run_context", "git_head"])
	};
};
var gitHeadOrNull = (worktree) => {
	try {
		return execFileSync("git", [
			"-C",
			worktree,
			"rev-parse",
			"HEAD"
		], { encoding: "utf8" }).trimEnd();
	} catch {
		return null;
	}
};
var isAncestor = (worktree, ancestor, descendant) => {
	try {
		execFileSync("git", [
			"-C",
			worktree,
			"merge-base",
			"--is-ancestor",
			ancestor,
			descendant
		], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};
var backendLabelOf = (backend) => {
	if (backend === "") return "missing";
	return backend;
};
var validateSessionShape = (previous) => {
	if (!backendSupportsResume(previous.backend)) return unavailable(`unsupported backend: ${backendLabelOf(previous.backend)}`);
	if (previous.persistence !== "resumable") return unavailable("backend_session.persistence is not resumable");
	if (previous.resumeId === "") return unavailable("backend_session.resume_id is missing");
	if (previous.repoRoot === "" || previous.worktreeRoot === "" || previous.gitHead === "") return unavailable("run_context required field is missing");
	return null;
};
var validateSessionMatch = (previous, expectation, reals) => {
	if (previous.backend !== expectation.expectedBackend) return unavailable(`backend mismatch: expected ${expectation.expectedBackend}, got ${previous.backend}`);
	if (previous.model !== expectation.expectedModel) return unavailable(`model mismatch: expected ${expectation.expectedModel}, got ${previous.model}`);
	if (previous.repoRoot !== reals.repoReal) return unavailable(`repo_root mismatch: expected ${reals.repoReal}, got ${previous.repoRoot}`);
	if (previous.worktreeRoot !== reals.worktreeReal) return unavailable(`worktree_root mismatch: expected ${reals.worktreeReal}, got ${previous.worktreeRoot}`);
	return null;
};
var validateGitHead = (previous, worktreeReal) => {
	const currentHead = gitHeadOrNull(worktreeReal);
	if (currentHead === null) return unavailable("current git_head is unavailable");
	if (previous.gitHead !== currentHead && !isAncestor(worktreeReal, previous.gitHead, currentHead)) return unavailable("git_head is not current HEAD or its ancestor");
	return null;
};
var validateAgainstWorktree = (previous, expectation) => {
	const repoReal = realpathSync(expectation.expectedRepoRoot);
	const worktreeReal = realpathSync(expectation.expectedWorktreeRoot);
	const matchFailure = validateSessionMatch(previous, expectation, {
		repoReal,
		worktreeReal
	});
	if (matchFailure !== null) return matchFailure;
	const headFailure = validateGitHead(previous, worktreeReal);
	if (headFailure !== null) return headFailure;
	return { ok: true };
};
var validateFollowup = (expectation) => {
	if (!hasFileContent(expectation.previousObserveFile)) return unavailable("previous observe JSON is missing");
	const previous = previousSessionOf(expectation.previousObserveFile);
	if (previous === null) return unavailable("previous observe JSON is invalid");
	const shapeFailure = validateSessionShape(previous);
	if (shapeFailure !== null) return shapeFailure;
	return validateAgainstWorktree(previous, expectation);
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
//#region shared/src/prepare.ts
var USAGE$1 = "Usage: prepare <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id> [session_mode]  (request body markdown on stdin)\n";
var failure$3 = (exitCode, stderr) => ({
	exitCode,
	stderr,
	stdout: ""
});
var parseSessionMode = (raw) => {
	if (raw === "") return {
		sessionMode: "",
		previousObserveFile: ""
	};
	if (raw === "resumable") return {
		sessionMode: "resumable",
		previousObserveFile: ""
	};
	if (raw.startsWith("followup=")) {
		const previousObserveFile = raw.slice(9);
		if (previousObserveFile === "") return failure$3(2, "ERROR: followup session_mode requires a previous observe_file path.\n");
		return {
			sessionMode: "followup",
			previousObserveFile
		};
	}
	return failure$3(2, `ERROR: session_mode must be empty, resumable, or followup=<previous_observe_file>: ${raw}\n`);
};
var chainOrTopLevel$1 = (raw) => {
	if (raw === "") return "[]";
	return raw;
};
var parsePrepareArgs = (argv) => {
	if (argv.length < 5) return failure$3(2, USAGE$1);
	const [taskType, typeEnv, defaultModel, parentChainArg, requesterSessionId] = argv;
	const mode = parseSessionMode(argv[5] ?? "");
	if ("exitCode" in mode) return mode;
	if (mode.sessionMode !== "" && taskType !== "implement" && taskType !== "chore") return failure$3(2, `ERROR: session_mode is only supported for implement/chore tasks: ${taskType}\n`);
	return {
		taskType,
		typeEnv,
		defaultModel,
		parentChain: chainOrTopLevel$1(parentChainArg),
		requesterSessionId,
		sessionMode: mode.sessionMode,
		previousObserveFile: mode.previousObserveFile
	};
};
var previousResumeMetadataOf = (observeFile) => {
	let parsed = null;
	try {
		parsed = JSON.parse(readFileOrEmpty(observeFile));
	} catch {
		return null;
	}
	if (parsed !== null && !isRecord$1(parsed)) return null;
	return {
		backend: stringOf(getPath(parsed, ["backend_session", "backend"])),
		model: stringOf(getPath(parsed, ["backend_session", "model"])),
		resumeId: stringOf(getPath(parsed, ["backend_session", "resume_id"])),
		resumeSource: stringOf(getPath(parsed, ["backend_session", "resume_source"])),
		backendSessionHome: stringOf(getPath(parsed, ["backend_session", "home_dir"])),
		lineageId: stringOf(getPath(parsed, ["lineage", "lineage_id"]))
	};
};
var gitRepoRoot = () => {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}).trimEnd();
	} catch {
		return process.cwd();
	}
};
var appendPrepareMetrics = (env, input) => {
	const record = {
		kind: input.kind,
		ts: metricsTimestamp()
	};
	if (input.kind === "prepare") record.duration_ms = input.durationMs ?? null;
	Object.assign(record, {
		task_type: input.taskType,
		type_env: input.typeEnv,
		default_model: input.defaultModel,
		model: input.model,
		model_source: input.modelSource,
		requester_session_id: input.requesterSessionId,
		task_type_chain: input.taskTypeChain,
		request_file: input.requestFile,
		response_file: input.responseFile,
		run_dir: input.runDir,
		observe_file: input.observeFile,
		body: {
			bytes: input.body.bytes,
			chars: input.body.chars,
			lines: input.body.lines,
			estimated_tokens: estimatedTokens(input.body.chars)
		}
	});
	appendMetrics(env.DELEGATE_METRICS_FILE, record);
};
var parseRunPaths = (stdout) => {
	const parsed = JSON.parse(stdout);
	if (!isRecord$1(parsed)) throw new Error("build-request stdout is not a JSON object");
	return {
		request_file: stringOf(parsed.request_file),
		response_file: stringOf(parsed.response_file),
		run_dir: stringOf(parsed.run_dir),
		observe_file: stringOf(parsed.observe_file)
	};
};
var modelSourceOf$1 = (env, typeEnv) => {
	if ((env[typeEnv] ?? "") !== "") return "env";
	return "default";
};
var resolveRequestedModel = (args, env) => {
	const modelSource = modelSourceOf$1(env, args.typeEnv);
	const resolved = runResolveModel([args.typeEnv, args.defaultModel], env);
	if (resolved.exitCode !== 0) return resolved;
	return {
		model: resolved.stdout.trimEnd(),
		modelSource,
		followup: null
	};
};
var missingFollowupFailure = (previousObserveFile) => {
	const cwd = process.cwd();
	const validation = validateFollowup({
		previousObserveFile,
		expectedBackend: "",
		expectedModel: "",
		expectedRepoRoot: cwd,
		expectedWorktreeRoot: cwd
	});
	if (!validation.ok) return failure$3(5, `${validation.message}\n`);
	return failure$3(5, "follow-up unavailable: previous observe JSON is missing\n");
};
var loadFollowupContext = (previousObserveFile) => {
	if (!hasFileContent(previousObserveFile)) return missingFollowupFailure(previousObserveFile);
	const previous = previousResumeMetadataOf(previousObserveFile);
	if (previous === null) return failure$3(5, "follow-up unavailable: previous observe JSON is invalid\n");
	return {
		previousObserveFile,
		previous
	};
};
var resolveModelPhase = (args, env) => {
	if (args.sessionMode !== "followup") return resolveRequestedModel(args, env);
	const loaded = loadFollowupContext(args.previousObserveFile);
	if ("exitCode" in loaded) return loaded;
	return {
		model: loaded.previous.model,
		modelSource: "followup",
		followup: loaded
	};
};
var validateEffortPhase = (backend, model, modelSource) => {
	if (modelSource === "followup") return null;
	const effort = validateModelEffort(backend, model);
	if (!effort.ok) return failure$3(6, `${effort.message}\n`);
	return null;
};
var validateFollowupPhase = (phase, backend, repoRoot) => {
	const { followup } = phase;
	if (followup === null) return null;
	const validation = validateFollowup({
		previousObserveFile: followup.previousObserveFile,
		expectedBackend: backend,
		expectedModel: phase.model,
		expectedRepoRoot: repoRoot,
		expectedWorktreeRoot: repoRoot
	});
	if (!validation.ok) return failure$3(5, `${validation.message}\n`);
	if (followup.previous.lineageId === "") return failure$3(5, "follow-up unavailable: lineage.lineage_id is missing\n");
	return null;
};
var validateResolvedPhase = (args, phase) => {
	const backend = backendFor(args.taskType, phase.model);
	const effortFailure = validateEffortPhase(backend, phase.model, phase.modelSource);
	if (effortFailure !== null) return effortFailure;
	const repoRoot = gitRepoRoot();
	const followupFailure = validateFollowupPhase(phase, backend, repoRoot);
	if (followupFailure !== null) return followupFailure;
	return {
		phase,
		backend,
		repoRoot
	};
};
var resolvePreparePhases = (args, env) => {
	const phase = resolveModelPhase(args, env);
	if ("exitCode" in phase) return phase;
	return validateResolvedPhase(args, phase);
};
var buildRequestPhase = (args, env, source) => {
	const chainResult = runCheckDelegateChain([args.taskType, args.parentChain]);
	if (chainResult.exitCode !== 0) return chainResult;
	const chainJson = chainResult.stdout.trimEnd();
	const buildResult = runBuildRequest([
		args.taskType,
		source.model,
		chainJson,
		args.requesterSessionId
	], env, source.body);
	if (buildResult.exitCode !== 0) return buildResult;
	return {
		chainJson,
		paths: parseRunPaths(buildResult.stdout)
	};
};
var EMPTY_SESSION = {
	lineageId: "",
	resumeId: "",
	resumeSource: "",
	backendSessionHome: ""
};
var recordFollowupSession = (followup, paths, repoRoot) => {
	updateLineage(paths.observe_file, paths.run_dir, {
		lineageId: followup.previous.lineageId,
		followupOf: followup.previousObserveFile
	});
	updateRunContext(paths.observe_file, paths.run_dir, {
		repoRoot,
		worktreeRoot: repoRoot
	});
	return {
		lineageId: followup.previous.lineageId,
		resumeId: followup.previous.resumeId,
		resumeSource: followup.previous.resumeSource,
		backendSessionHome: followup.previous.backendSessionHome
	};
};
var recordSession = (args, resolved, paths) => {
	if (args.sessionMode === "resumable") {
		const lineageId = path.basename(paths.run_dir);
		updateLineage(paths.observe_file, paths.run_dir, { lineageId });
		updateRunContext(paths.observe_file, paths.run_dir, {
			repoRoot: resolved.repoRoot,
			worktreeRoot: resolved.repoRoot
		});
		return {
			...EMPTY_SESSION,
			lineageId
		};
	}
	if (resolved.phase.followup !== null) return recordFollowupSession(resolved.phase.followup, paths, resolved.repoRoot);
	return EMPTY_SESSION;
};
var prepareOutput = (input, session) => {
	const { args, resolved, built } = input;
	const out = {
		model: resolved.phase.model,
		model_source: resolved.phase.modelSource,
		task_type_chain: JSON.parse(built.chainJson),
		request_file: built.paths.request_file,
		response_file: built.paths.response_file,
		run_dir: built.paths.run_dir,
		observe_file: built.paths.observe_file
	};
	if (args.sessionMode === "resumable") Object.assign(out, {
		session_mode: args.sessionMode,
		lineage_id: session.lineageId
	});
	if (args.sessionMode === "followup") Object.assign(out, {
		session_mode: args.sessionMode,
		lineage_id: session.lineageId,
		resume_id: session.resumeId,
		resume_source: session.resumeSource,
		backend_session_home: session.backendSessionHome
	});
	return {
		exitCode: 0,
		stderr: "",
		stdout: prettyJson(out)
	};
};
var finalizePrepare = (env, input) => {
	const { args, resolved, built } = input;
	initObserve({
		observeFile: built.paths.observe_file,
		runDir: built.paths.run_dir,
		taskType: args.taskType,
		model: resolved.phase.model,
		backend: resolved.backend,
		requestFile: built.paths.request_file,
		responseFile: built.paths.response_file,
		requesterSessionId: args.requesterSessionId,
		modelSource: resolved.phase.modelSource
	});
	const session = recordSession(args, resolved, built.paths);
	appendPrepareMetrics(env, {
		kind: "prepare",
		durationMs: elapsedMs(input.startMs),
		taskType: args.taskType,
		typeEnv: args.typeEnv,
		defaultModel: args.defaultModel,
		model: resolved.phase.model,
		modelSource: resolved.phase.modelSource,
		requesterSessionId: args.requesterSessionId,
		taskTypeChain: JSON.parse(built.chainJson),
		requestFile: built.paths.request_file,
		responseFile: built.paths.response_file,
		runDir: built.paths.run_dir,
		observeFile: built.paths.observe_file,
		body: bodyStats(input.body)
	});
	return prepareOutput(input, session);
};
var preparedRun = (args, env, readStdin) => {
	const startMs = monotonicMs();
	const body = stripTrailingNewlineBytes(readStdin());
	const resolved = resolvePreparePhases(args, env);
	if ("exitCode" in resolved) return resolved;
	const built = buildRequestPhase(args, env, {
		model: resolved.phase.model,
		body
	});
	if ("exitCode" in built) return built;
	return finalizePrepare(env, {
		args,
		resolved,
		built,
		body,
		startMs
	});
};
var runPrepare = (argv, env, readStdin) => {
	const args = parsePrepareArgs(argv);
	if ("exitCode" in args) return args;
	return preparedRun(args, env, readStdin);
};
//#endregion
//#region shared/src/prepare-imagegen.ts
var TASK_TYPE = "imagegen";
var TYPE_ENV = "DELEGATE_IMAGEGEN_MODEL";
var DEFAULT_MODEL = "gpt-5";
var USAGE = "Usage: prepare-imagegen <parent_task_type_chain_json> <requester_session_id>  (request body markdown on stdin)\n";
var failure$2 = (exitCode, stderr) => ({
	exitCode,
	stderr,
	stdout: ""
});
var modelSourceOf = (env) => {
	if ((env[TYPE_ENV] ?? "") !== "") return "env";
	return "default";
};
var resolveImagegenModel = (env) => {
	const modelSource = modelSourceOf(env);
	const resolved = runResolveModel([TYPE_ENV, DEFAULT_MODEL], env);
	if (resolved.exitCode !== 0) return resolved;
	const model = resolved.stdout.trimEnd();
	if (model.includes("@")) return failure$2(6, `ERROR: effort suffix is not supported for delegate-imagegen (model '${model}'); remove '@${model.slice(model.indexOf("@") + 1)}'\n`);
	return {
		model,
		modelSource
	};
};
var buildImagegenRequest = (parentChain, requesterSessionId, request) => {
	const chainResult = runCheckDelegateChain([TASK_TYPE, parentChain]);
	if (chainResult.exitCode !== 0) return chainResult;
	const chainJson = chainResult.stdout.trimEnd();
	const buildResult = runBuildRequest([
		TASK_TYPE,
		request.model,
		chainJson,
		requesterSessionId
	], request.env, request.body);
	if (buildResult.exitCode !== 0) return buildResult;
	return {
		chainJson,
		paths: parseRunPaths(buildResult.stdout)
	};
};
var finalizeImagegenPrepare = (env, input) => {
	const { resolved, built } = input;
	initObserve({
		observeFile: built.paths.observe_file,
		runDir: built.paths.run_dir,
		taskType: TASK_TYPE,
		model: resolved.model,
		backend: backendFor(TASK_TYPE, resolved.model),
		requestFile: built.paths.request_file,
		responseFile: built.paths.response_file,
		requesterSessionId: input.requesterSessionId,
		modelSource: resolved.modelSource
	});
	appendPrepareMetrics(env, {
		kind: "prepare_imagegen",
		taskType: TASK_TYPE,
		typeEnv: TYPE_ENV,
		defaultModel: DEFAULT_MODEL,
		model: resolved.model,
		modelSource: resolved.modelSource,
		requesterSessionId: input.requesterSessionId,
		taskTypeChain: JSON.parse(built.chainJson),
		requestFile: built.paths.request_file,
		responseFile: built.paths.response_file,
		runDir: built.paths.run_dir,
		observeFile: built.paths.observe_file,
		body: bodyStats(input.body)
	});
	return {
		exitCode: 0,
		stderr: "",
		stdout: prettyJson({
			model: resolved.model,
			model_source: resolved.modelSource,
			task_type_chain: JSON.parse(built.chainJson),
			request_file: built.paths.request_file,
			response_file: built.paths.response_file,
			run_dir: built.paths.run_dir,
			observe_file: built.paths.observe_file
		})
	};
};
var chainOrTopLevel = (raw) => {
	if (raw === "") return "[]";
	return raw;
};
var preparedImagegenRun = (parsed, env, body) => {
	const resolved = resolveImagegenModel(env);
	if ("exitCode" in resolved) return resolved;
	const built = buildImagegenRequest(parsed.parentChain, parsed.requesterSessionId, {
		model: resolved.model,
		body,
		env
	});
	if ("exitCode" in built) return built;
	return finalizeImagegenPrepare(env, {
		requesterSessionId: parsed.requesterSessionId,
		resolved,
		built,
		body
	});
};
var runPrepareImagegen = (argv, env, readStdin) => {
	if (argv.length < 2) return failure$2(2, USAGE);
	const [parentChainArg, requesterSessionId] = argv;
	return preparedImagegenRun({
		parentChain: chainOrTopLevel(parentChainArg),
		requesterSessionId
	}, env, stripTrailingNewlineBytes(readStdin()));
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
//#region shared/src/run-oneshot.ts
var contentMaxOf = (env) => {
	const raw = env.DELEGATE_RUN_CONTENT_MAX ?? "16384";
	if (raw === "" || /[^0-9]/.test(raw)) return 16384;
	return Number(raw);
};
var utf8ByteLength = (text) => Buffer.byteLength(text, "utf8");
var codePointsOf = (text) => {
	const points = [];
	for (const point of text) points.push(point);
	return points;
};
var clipBytes = (text, maxBytes) => {
	const points = codePointsOf(text);
	let low = 0;
	let high = points.length;
	while (high - low > 1) {
		const mid = Math.floor((low + high) / 2);
		if (utf8ByteLength(points.slice(0, mid).join("")) <= maxBytes) low = mid;
		else high = mid;
	}
	return points.slice(0, low).join("");
};
var nullIfEmpty = (value) => {
	if (value === "") return null;
	return value;
};
var clippedContent = (content, maxBytes, truncated) => {
	if (truncated) return clipBytes(content, maxBytes);
	return content;
};
var runJson = (env, input) => {
	const maxBytes = contentMaxOf(env);
	const truncated = maxBytes > 0 && utf8ByteLength(input.content) > maxBytes;
	return prettyJson({
		exit_code: input.exitCode,
		status: input.status,
		content: clippedContent(input.content, maxBytes, truncated),
		content_truncated: truncated,
		response_file: nullIfEmpty(input.responseFile),
		observe_file: nullIfEmpty(input.observeFile),
		run_dir: nullIfEmpty(input.runDir)
	});
};
var failureJson = (env, failed) => ({
	exitCode: failed.exitCode,
	stderr: "",
	stdout: runJson(env, {
		exitCode: failed.exitCode,
		status: "failed",
		content: failed.content,
		responseFile: "",
		observeFile: "",
		runDir: ""
	})
});
var usageError = (env, usageText) => {
	return {
		...failureJson(env, {
			exitCode: 2,
			content: `${usageText}\n`
		}),
		stderr: `${usageText}\n`
	};
};
var defaultSelector = (taskType) => {
	if (taskType === "review") return "decision";
	return "auto";
};
var selectorOf = (taskType, requested) => {
	if (requested !== "") return requested;
	return defaultSelector(taskType);
};
var responseStatusOf = (responseFile) => {
	try {
		const parsed = JSON.parse(readFileOrEmpty(responseFile));
		if (isRecord$1(parsed) && typeof parsed.status === "string") return parsed.status;
		return "failed";
	} catch {
		return "failed";
	}
};
var preparedRunOf = (prepareStdout) => {
	const parsed = JSON.parse(prepareStdout);
	const model = (() => {
		if (isRecord$1(parsed)) return stringOf(parsed.model);
		return "";
	})();
	const paths = parseRunPaths(prepareStdout);
	return {
		model,
		requestFile: paths.request_file,
		responseFile: paths.response_file,
		runDir: paths.run_dir,
		observeFile: paths.observe_file
	};
};
var readResponseContent = (config, prepared) => {
	const status = responseStatusOf(prepared.responseFile);
	const read = runReadResponse([prepared.responseFile, config.selector], config.env);
	if (read.exitCode === 0) return {
		status,
		content: read.stdout,
		readStatus: 0
	};
	return {
		status: "failed",
		content: `${read.stdout}${read.stderr}`,
		readStatus: read.exitCode
	};
};
var collectOutcome = (config, prepared, dispatched) => {
	if (hasFileContent(prepared.responseFile)) return readResponseContent(config, prepared);
	return {
		status: "failed",
		content: dispatched.stderr,
		readStatus: 0
	};
};
var exitCodeOf = (dispatched, outcome) => {
	if (dispatched.exitCode !== 0) return dispatched.exitCode;
	return outcome.readStatus;
};
var oneShot = (config) => {
	const prepared = config.prepare();
	if (prepared.exitCode !== 0) return failureJson(config.env, {
		exitCode: prepared.exitCode,
		content: prepared.stderr
	});
	const paths = preparedRunOf(prepared.stdout);
	config.io.writeStderr(`observe_file: ${paths.observeFile}\n`);
	const dispatched = config.dispatch(paths);
	const outcome = collectOutcome(config, paths, dispatched);
	const exitCode = exitCodeOf(dispatched, outcome);
	return {
		exitCode,
		stderr: "",
		stdout: runJson(config.env, {
			exitCode,
			status: outcome.status,
			content: outcome.content,
			responseFile: paths.responseFile,
			observeFile: paths.observeFile,
			runDir: paths.runDir
		})
	};
};
var RUN_USAGE = "Usage: run <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id> [selector]  (request body markdown on stdin)";
var runRun = (argv, context, readStdin) => {
	if (argv.length < 5) return usageError(context.env, RUN_USAGE);
	const [taskType, typeEnv, defaultModel, parentChain, requesterSessionId] = argv;
	return oneShot({
		taskType,
		selector: selectorOf(taskType, argv[5] ?? ""),
		env: context.env,
		io: context.io,
		prepare: () => runPrepare([
			taskType,
			typeEnv,
			defaultModel,
			parentChain,
			requesterSessionId
		], context.env, readStdin),
		dispatch: (paths) => runDispatch([
			paths.model,
			taskType,
			paths.requestFile,
			paths.responseFile,
			paths.runDir,
			paths.observeFile
		], context.env, {
			scriptsDir: context.io.scriptsDir,
			captureStderr: true
		})
	});
};
var dedicatedWrapperDispatch = (context, wrapperScript, paths) => {
	const outcome = spawnWrapper({
		script: path.join(context.io.scriptsDir, wrapperScript),
		args: [
			paths.model,
			paths.requestFile,
			paths.responseFile,
			paths.runDir,
			paths.observeFile
		],
		env: context.env,
		captureStderr: true
	});
	return {
		exitCode: outcome.exitCode,
		stderr: outcome.stderr
	};
};
var RUN_IMAGEGEN_USAGE = "Usage: run-imagegen <parent_task_type_chain_json> <requester_session_id> [selector]  (request body markdown on stdin)";
var runRunImagegen = (argv, context, readStdin) => {
	if (argv.length < 2) return usageError(context.env, RUN_IMAGEGEN_USAGE);
	const [parentChain, requesterSessionId] = argv;
	return oneShot({
		taskType: "imagegen",
		selector: selectorOf("imagegen", argv[2] ?? ""),
		env: context.env,
		io: context.io,
		prepare: () => runPrepareImagegen([parentChain, requesterSessionId], context.env, readStdin),
		dispatch: (paths) => dedicatedWrapperDispatch(context, "delegate-imagegen-codex.sh", paths)
	});
};
var RUN_X_RESEARCH_USAGE = "Usage: run-x-research <parent_task_type_chain_json> <requester_session_id> [selector]  (request body markdown on stdin)";
var runRunXResearch = (argv, context, readStdin) => {
	if (argv.length < 2) return usageError(context.env, RUN_X_RESEARCH_USAGE);
	const [parentChain, requesterSessionId] = argv;
	return oneShot({
		taskType: "xresearch",
		selector: selectorOf("xresearch", argv[2] ?? ""),
		env: context.env,
		io: context.io,
		prepare: () => runPrepare([
			"xresearch",
			"DELEGATE_X_RESEARCH_MODEL",
			"grok-build",
			parentChain,
			requesterSessionId
		], context.env, readStdin),
		dispatch: (paths) => dedicatedWrapperDispatch(context, "delegate-x-research-grok.sh", paths)
	});
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
var EMPTY_STDIN = () => Buffer.alloc(0);
var stdinForMinArgs = (readStdin, args) => {
	if (args.rest.length < args.minArgs) return Buffer.alloc(0);
	return readStdin();
};
var scriptsDirOf = (entry) => {
	const dir = path.dirname(path.resolve(entry));
	if (path.basename(dir) === "dist") return path.dirname(dir);
	return dir;
};
var oneShotIo = () => ({
	scriptsDir: scriptsDirOf(process.argv[1] ?? "."),
	writeStderr: (text) => {
		process.stderr.write(text);
	}
});
var HANDLERS = {
	"--version": () => versionResult(),
	version: () => versionResult(),
	"md2idx-smoke": () => md2idxSmokeResult(),
	"resolve-model": (rest) => runResolveModel(rest, process.env),
	"check-delegate-chain": (rest) => runCheckDelegateChain(rest),
	"build-request": (rest, readStdin) => runBuildRequest(rest, process.env, stdinForMinArgs(readStdin, {
		rest,
		minArgs: 4
	})),
	"read-request": (rest) => runReadRequest(rest, process.env),
	"build-response": (rest, readStdin) => runBuildResponse(rest, process.env, stdinForMinArgs(readStdin, {
		rest,
		minArgs: 3
	})),
	"read-response": (rest) => runReadResponse(rest, process.env),
	prepare: (rest, readStdin) => runPrepare(rest, process.env, readStdin),
	"prepare-imagegen": (rest, readStdin) => runPrepareImagegen(rest, process.env, readStdin),
	dispatch: (rest) => runDispatch(rest, process.env, { scriptsDir: scriptsDirOf(process.argv[1] ?? ".") }),
	run: (rest, readStdin) => runRun(rest, {
		env: process.env,
		io: oneShotIo()
	}, readStdin),
	"run-imagegen": (rest, readStdin) => runRunImagegen(rest, {
		env: process.env,
		io: oneShotIo()
	}, readStdin),
	"run-x-research": (rest, readStdin) => runRunXResearch(rest, {
		env: process.env,
		io: oneShotIo()
	}, readStdin)
};
var runCli = (argv, readStdin = EMPTY_STDIN) => {
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
	return handler(rest, readStdin);
};
{
	const result = runCli(process.argv.slice(2), () => readFileSync(0));
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.exitCode;
}
//#endregion
export { CLI_VERSION, runCli };
