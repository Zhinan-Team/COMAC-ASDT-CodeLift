import ignore from "ignore";
import OpenAI from "openai";
import path from "path";
import { ConfigHandler } from "../config/ConfigHandler.js";
import { TRIAL_FIM_MODEL } from "../config/onboarding.js";
import { streamLines } from "../diff/util.js";
import { IDE, ILLM, ModelProvider, TabAutocompleteOptions } from "../index.js";
import { logDevData } from "../util/devdata.js";
import { getBasename, getLastNPathParts } from "../util/index.js";
import {
  COUNT_COMPLETION_REJECTED_AFTER,
  DEFAULT_AUTOCOMPLETE_OPTS,
} from "../util/parameters.js";
import { Telemetry } from "../util/posthog.js";
import { getRangeInString } from "../util/ranges.js";

import { AutocompleteLanguageInfo } from "./constants/AutocompleteLanguageInfo.js";
import {
  constructAutocompletePrompt,
  languageForFilepath,
} from "./constructPrompt.js";
import { AutocompleteSnippet } from "./context/ranking/index.js";
import { RootPathContextService } from "./context/RootPathContextService.js";
import { GeneratorReuseManager } from "./generation/GeneratorReuseManager.js";
import { postprocessCompletion } from "./postprocessing/index.js";
import { getTemplateForModel } from "./templating/AutocompleteTemplate.js";
// @prettier-ignore
import Handlebars from "handlebars";
import { getConfigJsonPath } from "../util/paths.js";
import { AutocompleteDebouncer } from "./AutocompleteDebouncer.js";
import AutocompleteLruCache from "./AutocompleteLruCache.js";
import { ImportDefinitionsService } from "./context/ImportDefinitionsService.js";
import { BracketMatchingService } from "./filtering/BracketMatchingService.js";
import { stopAtStopTokens } from "./filtering/streamTransforms/charStream.js";
import {
  avoidPathLineAndEmptyComments,
  skipPrefixes,
  stopAtLines,
  stopAtRepeatingLines,
  stopAtSimilarLine,
  streamWithNewLines,
} from "./filtering/streamTransforms/lineStream.js";
import { formatExternalSnippet } from "./templating/index.js";
import { AutocompleteInput, AutocompleteOutcome } from "./types.js";

const autocompleteCache = AutocompleteLruCache.get();

// Errors that can be expected on occasion even during normal functioning should not be shown.
// Not worth disrupting the user to tell them that a single autocomplete request didn't go through
const ERRORS_TO_IGNORE = [
  // From Ollama
  "unexpected server status",
];

const LOCAL_PROVIDERS: ModelProvider[] = [
  "ollama",
  "lmstudio",
  "llama.cpp",
  "llamafile",
  "text-gen-webui",
];

export type GetLspDefinitionsFunction = (
  filepath: string,
  contents: string,
  cursorIndex: number,
  ide: IDE,
  lang: AutocompleteLanguageInfo,
) => Promise<AutocompleteSnippet[]>;

export class CompletionProvider {
  private importDefinitionsService: ImportDefinitionsService;
  private rootPathContextService: RootPathContextService;
  private generatorReuseManager: GeneratorReuseManager;
  private autocompleteCache = AutocompleteLruCache.get();
  public errorsShown: Set<string> = new Set();
  private bracketMatchingService = new BracketMatchingService();
  private debouncer = new AutocompleteDebouncer();
  // private nearbyDefinitionsService = new NearbyDefinitionsService();

  constructor(
    private readonly configHandler: ConfigHandler,
    private readonly ide: IDE,
    private readonly getLlm: () => Promise<ILLM | undefined>,
    private readonly _onError: (e: any) => void,
    private readonly getDefinitionsFromLsp: GetLspDefinitionsFunction,
  ) {
    this.generatorReuseManager = new GeneratorReuseManager(
      this.onError.bind(this),
    );
    this.importDefinitionsService = new ImportDefinitionsService(this.ide);
    this.rootPathContextService = new RootPathContextService(
      this.importDefinitionsService,
      this.ide,
    );
  }

  private onError(e: any) {
    console.warn("Error generating autocompletion: ", e);
    if (
      ERRORS_TO_IGNORE.some((err) =>
        typeof e === "string" ? e.includes(err) : e?.message?.includes(err),
      )
    ) {
      return;
    }
    if (!this.errorsShown.has(e.message)) {
      this.errorsShown.add(e.message);
      this._onError(e);
    }
  }

  public cancel() {
    this._abortControllers.forEach((abortController, id) => {
      abortController.abort();
    });
    this._abortControllers.clear();
  }

  // Key is completionId
  private _abortControllers = new Map<string, AbortController>();
  private _logRejectionTimeouts = new Map<string, NodeJS.Timeout>();
  private _outcomes = new Map<string, AutocompleteOutcome>();

  public accept(completionId: string) {
    if (this._logRejectionTimeouts.has(completionId)) {
      clearTimeout(this._logRejectionTimeouts.get(completionId));
      this._logRejectionTimeouts.delete(completionId);
    }

    if (this._outcomes.has(completionId)) {
      const outcome = this._outcomes.get(completionId)!;
      this.logAcceptedCompletion(completionId, outcome);
      this._outcomes.delete(completionId);

      this.bracketMatchingService.handleAcceptedCompletion(
        outcome.completion,
        outcome.filepath,
      );
    }
  }

  private logAcceptedCompletion(
    completionId: string,
    outcome: AutocompleteOutcome,
  ) {
    outcome.accepted = true;
    logDevData("autocomplete", outcome);
    void Telemetry.capture(
      "autocomplete",
      {
        accepted: outcome.accepted,
        modelName: outcome.modelName,
        modelProvider: outcome.modelProvider,
        time: outcome.time,
        cacheHit: outcome.cacheHit,
      },
      true,
    );
  }

  public cancelRejectionTimeout(completionId: string) {
    if (this._logRejectionTimeouts.has(completionId)) {
      clearTimeout(this._logRejectionTimeouts.get(completionId)!);
      this._logRejectionTimeouts.delete(completionId);
    }

    if (this._outcomes.has(completionId)) {
      this._outcomes.delete(completionId);
    }
  }

  public async provideInlineCompletionItems(
    input: AutocompleteInput,
    token: AbortSignal | undefined,
  ): Promise<AutocompleteOutcome | undefined> {
    try {
      const config = await this.configHandler.loadConfig();
      const options = {
        ...DEFAULT_AUTOCOMPLETE_OPTS,
        ...config.tabAutocompleteOptions,
      };

      // Check whether we're in the continue config.json file
      if (input.filepath === getConfigJsonPath()) {
        return undefined;
      }

      // Check whether autocomplete is disabled for this file
      if (options.disableInFiles) {
        // Relative path needed for `ignore`
        const workspaceDirs = await this.ide.getWorkspaceDirs();
        let filepath = input.filepath;
        for (const workspaceDir of workspaceDirs) {
          const relativePath = path.relative(workspaceDir, filepath);
          const relativePathBase = relativePath.split(path.sep).at(0);
          const isInWorkspace =
            !path.isAbsolute(relativePath) && relativePathBase !== "..";
          if (isInWorkspace) {
            filepath = path.relative(workspaceDir, filepath);
            break;
          }
        }

        // Worst case we can check filetype glob patterns
        if (filepath === input.filepath) {
          filepath = getBasename(filepath);
        }

        // @ts-ignore
        const pattern = ignore.default().add(options.disableInFiles);
        if (pattern.ignores(filepath)) {
          return undefined;
        }
      }

      // Create abort signal if not given
      if (!token) {
        const controller = new AbortController();
        token = controller.signal;
        this._abortControllers.set(input.completionId, controller);
      }

      // Allow disabling autocomplete from config.json
      if (options.disable) {
        return undefined;
      }

      // Debounce
      if (await this.debouncer.delayAndShouldDebounce(options.debounceDelay)) {
        return undefined;
      }

      // Get completion
      const llm = await this.getLlm();

      if (!llm) {
        return undefined;
      }

      // Ignore empty API keys for Mistral since we currently write
      // a template provider without one during onboarding
      if (llm.providerName === "mistral" && llm.apiKey === "") {
        return undefined;
      }

      // Set temperature (but don't overrride)
      if (llm.completionOptions.temperature === undefined) {
        llm.completionOptions.temperature = 0.01;
      }

      if (
        !config.tabAutocompleteOptions?.maxPromptTokens &&
        LOCAL_PROVIDERS.includes(llm.providerName)
      ) {
        options.maxPromptTokens = 500;
      }

      const outcome = await this.getTabCompletion(token, options, llm, input);

      if (!outcome?.completion) {
        return undefined;
      }

      // Do some stuff later so as not to block return. Latency matters
      const completionToCache = outcome.completion;
      setTimeout(async () => {
        if (!outcome.cacheHit) {
          (await this.autocompleteCache).put(outcome.prefix, completionToCache);
        }
      }, 100);

      return outcome;
    } catch (e: any) {
      this.onError(e);
    } finally {
      this._abortControllers.delete(input.completionId);
    }
  }

  _lastDisplayedCompletion: { id: string; displayedAt: number } | undefined =
    undefined;

  markDisplayed(completionId: string, outcome: AutocompleteOutcome) {
    const logRejectionTimeout = setTimeout(() => {
      // Wait 10 seconds, then assume it wasn't accepted
      outcome.accepted = false;
      logDevData("autocomplete", outcome);
      const { prompt, completion, prefix, suffix, ...restOfOutcome } = outcome;
      void Telemetry.capture(
        "autocomplete",
        {
          accepted: restOfOutcome.accepted,
          cacheHit: restOfOutcome.cacheHit,
          completionId: restOfOutcome.completionId,
          completionOptions: restOfOutcome.completionOptions,
          debounceDelay: restOfOutcome.debounceDelay,
          fileExtension: restOfOutcome.filepath.split(".")?.slice(-1)[0],
          maxPromptTokens: restOfOutcome.maxPromptTokens,
          modelName: restOfOutcome.modelName,
          modelProvider: restOfOutcome.modelProvider,
          multilineCompletions: restOfOutcome.multilineCompletions,
          time: restOfOutcome.time,
          useRecentlyEdited: restOfOutcome.useRecentlyEdited,
          useRootPathContext: restOfOutcome.useRootPathContext,
        },
        true,
      );
      this._logRejectionTimeouts.delete(completionId);
    }, COUNT_COMPLETION_REJECTED_AFTER);
    this._outcomes.set(completionId, outcome);
    this._logRejectionTimeouts.set(completionId, logRejectionTimeout);

    // If the previously displayed completion is still waiting for rejection,
    // and this one is a continuation of that (the outcome.completion is the same modulo prefix)
    // then we should cancel the rejection timeout
    const previous = this._lastDisplayedCompletion;
    const now = Date.now();
    if (previous && this._logRejectionTimeouts.has(previous.id)) {
      const previousOutcome = this._outcomes.get(previous.id);
      const c1 = previousOutcome?.completion.split("\n")[0] ?? "";
      const c2 = outcome.completion.split("\n")[0];
      if (
        previousOutcome &&
        (c1.endsWith(c2) ||
          c2.endsWith(c1) ||
          c1.startsWith(c2) ||
          c2.startsWith(c1))
      ) {
        this.cancelRejectionTimeout(previous.id);
      } else if (now - previous.displayedAt < 500) {
        // If a completion isn't shown for more than
        this.cancelRejectionTimeout(previous.id);
      }
    }

    this._lastDisplayedCompletion = {
      id: completionId,
      displayedAt: now,
    };
  }

  private isMultiline({
    language,
    prefix,
    suffix,
    selectedCompletionInfo,
    multilineCompletions,
    completeMultiline,
  }: {
    language: AutocompleteLanguageInfo;
    prefix: string;
    suffix: string;
    selectedCompletionInfo: AutocompleteInput["selectedCompletionInfo"];
    multilineCompletions: TabAutocompleteOptions["multilineCompletions"];
    completeMultiline: boolean;
  }) {
    let langMultilineDecision = language.useMultiline?.({ prefix, suffix });
    if (langMultilineDecision) {
      return langMultilineDecision;
    } else {
      return (
        !selectedCompletionInfo && // Only ever single-line if using intellisense selected value
        multilineCompletions !== "never" &&
        (multilineCompletions === "always" || completeMultiline)
      );
    }
  }

  async getTabCompletion(
    token: AbortSignal,
    options: TabAutocompleteOptions,
    llm: ILLM,
    input: AutocompleteInput,
  ): Promise<AutocompleteOutcome | undefined> {
    const startTime = Date.now();

    const {
      filepath,
      pos,
      recentlyEditedFiles,
      recentlyEditedRanges,
      clipboardText,
      manuallyPassFileContents,
      manuallyPassPrefix,
    } = input;
    const fileContents =
      manuallyPassFileContents ?? (await this.ide.readFile(filepath));
    const fileLines = fileContents.split("\n");

    // Filter
    const lang = languageForFilepath(filepath);

    if (options.transform) {
      const line = fileLines[pos.line] ?? "";
      for (const endOfLine of lang.endOfLine) {
        if (line.endsWith(endOfLine) && pos.character >= line.length) {
          return undefined;
        }
      }
    }

    // Model
    if (!llm) {
      return;
    }
    if (llm instanceof OpenAI) {
      llm.useLegacyCompletionsEndpoint = true;
    } else if (
      llm.providerName === "free-trial" &&
      llm.model !== TRIAL_FIM_MODEL
    ) {
      llm.model = TRIAL_FIM_MODEL;
    }

    // Prompt
    let fullPrefix =
      getRangeInString(fileContents, {
        start: { line: 0, character: 0 },
        end: input.selectedCompletionInfo?.range.start ?? pos,
      }) + (input.selectedCompletionInfo?.text ?? "");

    if (input.injectDetails) {
      const lines = fullPrefix.split("\n");
      fullPrefix = `${lines.slice(0, -1).join("\n")}\n${
        lang.singleLineComment
      } ${input.injectDetails
        .split("\n")
        .join(`\n${lang.singleLineComment} `)}\n${lines[lines.length - 1]}`;
    }

    const fullSuffix = getRangeInString(fileContents, {
      start: pos,
      end: { line: fileLines.length - 1, character: Number.MAX_SAFE_INTEGER },
    });

    // First non-whitespace line below the cursor
    let lineBelowCursor = "";
    let i = 1;
    while (
      lineBelowCursor.trim() === "" &&
      pos.line + i <= fileLines.length - 1
    ) {
      lineBelowCursor = fileLines[Math.min(pos.line + i, fileLines.length - 1)];
      i++;
    }

    let extrasSnippets = options.useOtherFiles
      ? ((await Promise.race([
          this.getDefinitionsFromLsp(
            filepath,
            fullPrefix + fullSuffix,
            fullPrefix.length,
            this.ide,
            lang,
          ),
          new Promise((resolve) => {
            setTimeout(() => resolve([]), 100);
          }),
        ])) as AutocompleteSnippet[])
      : [];

    const workspaceDirs = await this.ide.getWorkspaceDirs();
    if (options.onlyMyCode) {
      extrasSnippets = extrasSnippets.filter((snippet) => {
        return workspaceDirs.some((dir) => snippet.filepath.startsWith(dir));
      });
    }

    let { prefix, suffix, completeMultiline, snippets } =
      await constructAutocompletePrompt(
        filepath,
        pos.line,
        fullPrefix,
        fullSuffix,
        clipboardText,
        lang,
        options,
        recentlyEditedRanges,
        recentlyEditedFiles,
        llm.model,
        extrasSnippets,
        this.importDefinitionsService,
        this.rootPathContextService,
      );

    // If prefix is manually passed
    if (manuallyPassPrefix) {
      prefix = manuallyPassPrefix;
      suffix = "";
    }

    // Template prompt
    const {
      template,
      completionOptions,
      compilePrefixSuffix = undefined,
    } = options.template
      ? { template: options.template, completionOptions: {} }
      : getTemplateForModel(llm.model);

    let prompt: string;
    const filename = getBasename(filepath);
    const reponame = getBasename(workspaceDirs[0] ?? "myproject");

    // Some models have prompts that need two passes. This lets us pass the compiled prefix/suffix
    // into either the 2nd template to generate a raw string, or to pass prefix, suffix to a FIM endpoint
    if (compilePrefixSuffix) {
      [prefix, suffix] = compilePrefixSuffix(
        prefix,
        suffix,
        filepath,
        reponame,
        snippets,
      );
    }

    if (typeof template === "string") {
      const compiledTemplate = Handlebars.compile(template);

      // Format snippets as comments and prepend to prefix
      const formattedSnippets = snippets
        .map((snippet) =>
          formatExternalSnippet(snippet.filepath, snippet.contents, lang),
        )
        .join("\n");
      if (formattedSnippets.length > 0) {
        prefix = `${formattedSnippets}\n\n${prefix}`;
      } else if (prefix.trim().length === 0 && suffix.trim().length === 0) {
        // If it's an empty file, include the file name as a comment
        prefix = `${lang.singleLineComment} ${getLastNPathParts(
          filepath,
          2,
        )}\n${prefix}`;
      }

      prompt = compiledTemplate({
        prefix,
        suffix,
        filename,
        reponame,
        language: lang.name,
      });
    } else {
      // Let the template function format snippets
      prompt = template(
        prefix,
        suffix,
        filepath,
        reponame,
        lang.name,
        snippets,
      );
    }

    // Completion
    let completion = "";

    const cache = await autocompleteCache;
    const cachedCompletion = options.useCache
      ? await cache.get(prefix)
      : undefined;
    let cacheHit = false;
    if (cachedCompletion) {
      // Cache
      cacheHit = true;
      completion = cachedCompletion;
    } else {
      const stop = [
        ...(completionOptions?.stop || []),
        // ...multilineStops,
        ...commonStops,
        ...(llm.model.toLowerCase().includes("starcoder2")
          ? STARCODER2_T_ARTIFACTS
          : []),
        ...(lang.stopWords ?? []),
        // ...lang.topLevelKeywords.map((word) => `\n${word}`),
      ];

      const multiline =
        !options.transform ||
        this.isMultiline({
          multilineCompletions: options.multilineCompletions,
          language: lang,
          selectedCompletionInfo: input.selectedCompletionInfo,
          prefix,
          suffix,
          completeMultiline,
        });

      // Try to reuse pending requests if what the user typed matches start of completion
      const generator = this.generatorReuseManager.getGenerator(
        prefix,
        () =>
          llm.supportsFim()
            ? llm.streamFim(prefix, suffix, {
                ...completionOptions,
                stop,
              })
            : llm.streamComplete(prompt, {
                ...completionOptions,
                raw: true,
                stop,
              }),
        multiline,
      );

      // Full stop means to stop the LLM's generation, instead of just truncating the displayed completion
      const fullStop = () =>
        this.generatorReuseManager.currentGenerator?.cancel();

      // LLM
      let cancelled = false;
      const generatorWithCancellation = async function* () {
        for await (const update of generator) {
          if (token.aborted) {
            cancelled = true;
            return;
          }
          yield update;
        }
      };
      let charGenerator = generatorWithCancellation();

      if (options.transform) {
        // charGenerator = noFirstCharNewline(charGenerator);
        // charGenerator = onlyWhitespaceAfterEndOfLine(
        //   charGenerator,
        //   lang.endOfLine,
        //   fullStop,
        // );
        charGenerator = stopAtStopTokens(charGenerator, stop);
        charGenerator =
          this.bracketMatchingService.stopOnUnmatchedClosingBracket(
            charGenerator,
            prefix,
            suffix,
            filepath,
            multiline,
          );
      }

      let lineGenerator = streamLines(charGenerator);
      if (options.transform) {
        lineGenerator = stopAtLines(lineGenerator, fullStop);
        lineGenerator = stopAtRepeatingLines(lineGenerator, fullStop);
        lineGenerator = avoidPathLineAndEmptyComments(
          lineGenerator,
          lang.singleLineComment,
        );
        lineGenerator = skipPrefixes(lineGenerator);

        // lineGenerator = noTopLevelKeywordsMidline(
        //   lineGenerator,
        //   lang.topLevelKeywords,
        //   fullStop,
        // );
        for (const lineFilter of lang.lineFilters ?? []) {
          lineGenerator = lineFilter({ lines: lineGenerator, fullStop });
        }

        lineGenerator = stopAtSimilarLine(
          lineGenerator,
          lineBelowCursor,
          fullStop,
        );
      }

      const finalGenerator = streamWithNewLines(lineGenerator);

      try {
        for await (const update of finalGenerator) {
          completion += update;
        }
      } catch (e: any) {
        if (ERRORS_TO_IGNORE.some((err) => e.includes(err))) {
          return undefined;
        }
        throw e;
      }

      if (cancelled) {
        return undefined;
      }

      const processedCompletion = options.transform
        ? postprocessCompletion({
            completion,
            prefix,
            suffix,
            llm,
          })
        : completion;

      if (!processedCompletion) {
        return undefined;
      }
      completion = processedCompletion;
    }

    const time = Date.now() - startTime;
    return {
      time,
      completion,
      prefix,
      suffix,
      prompt,
      modelProvider: llm.providerName,
      modelName: llm.model,
      completionOptions,
      cacheHit,
      filepath: input.filepath,
      completionId: input.completionId,
      gitRepo: await this.ide.getRepoName(input.filepath),
      uniqueId: await this.ide.getUniqueId(),
      ...options,
    };
  }
}
