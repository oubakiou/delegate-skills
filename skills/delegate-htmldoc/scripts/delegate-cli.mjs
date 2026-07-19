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
//#region shared/src/check-delegate-chain.ts
var failure = (exitCode, stderr) => ({
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
		return failure(5, `ERROR: parent_task_type_chain is not valid JSON: ${rawChain}\n`);
	}
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return failure(5, `ERROR: parent_task_type_chain is not a JSON string array: ${rawChain}\n`);
	return parsed.map(String);
};
var runCheckDelegateChain = (argv) => {
	if (argv.length < 2) return failure(2, "Usage: check-delegate-chain <task_type> <parent_task_type_chain_json>\n");
	const [taskType, rawChainArg] = argv;
	const rawChain = normalizeChain(rawChainArg);
	const chain = parseChain(rawChain);
	if (!Array.isArray(chain)) return chain;
	if (chain.includes(taskType)) return failure(4, `ERROR: 委譲チェーンに '${taskType}' が既に存在します（同一種別の多段委譲は禁止）: ${rawChain}\n`);
	return {
		exitCode: 0,
		stderr: "",
		stdout: `${JSON.stringify([...chain, taskType])}\n`
	};
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
var runCli = (argv) => {
	if (argv.length === 0) return {
		exitCode: 2,
		stderr: "delegate-cli: missing subcommand (try --version)\n",
		stdout: ""
	};
	const [subcommand, ...rest] = argv;
	switch (subcommand) {
		case "--version":
		case "version": return versionResult();
		case "md2idx-smoke": return md2idxSmokeResult();
		case "resolve-model": return runResolveModel(rest, process.env);
		case "check-delegate-chain": return runCheckDelegateChain(rest);
		default: return {
			exitCode: 2,
			stderr: `delegate-cli: unknown subcommand: ${subcommand}\n`,
			stdout: ""
		};
	}
};
{
	const result = runCli(process.argv.slice(2));
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.exitCode;
}
//#endregion
export { CLI_VERSION, runCli };
